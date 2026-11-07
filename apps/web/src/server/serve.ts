import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { EffectSchemaToJsonSchemaConverter } from "@orpc/effect";
import { SmartCoercionHandlerPlugin } from "@orpc/json-schema";
import { McpRegistrar } from "@orpc/mcp";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { COMMON_ERROR_STATUS_MAP, ORPCError, RPCSerializer } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersHandlerPlugin } from "@orpc/server/plugins";
import type { StandardHandlerInterceptor } from "@orpc/server/standard";
import type { AnswerCache } from "@stargrep/api/answer-cache";
import { anyoneCanCall, type PublicConfig } from "@stargrep/api/contract";
import { errorStatus, type WireCode, wireError, withTraceId } from "@stargrep/api/errors";
import type { Transport } from "@stargrep/api/middleware/instrumentation";
import { type ApiContext, router } from "@stargrep/api/router";
import { type ApiServices, ApiServicesUnavailable } from "@stargrep/api/services";
import * as Auth from "@stargrep/auth/auth";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";

export type RequestLayer = (request: Request) => Layer.Layer<ApiServices, { readonly _tag: string }>;

interface WebContext extends ApiContext {
  readonly requestTraceId: string;
}

// oRPC decodes the body before any procedure middleware runs, so a body it cannot decode gets the request's trace ID here.
const traceErrors: StandardHandlerInterceptor<WebContext> = async (options) => {
  const decodeInput = () =>
    options.decodeInput().catch((cause: unknown) => {
      throw cause instanceof ORPCError ? cause : wireError("BAD_REQUEST", options.context.requestTraceId);
    });
  try {
    return await options.next({ ...options, decodeInput });
  } catch (error) {
    throw error instanceof ORPCError ? withTraceId(error, options.context.requestTraceId) : error;
  }
};

const converters = [new EffectSchemaToJsonSchemaConverter({ cache: true })];
const plugins = [new SmartCoercionHandlerPlugin({ converters })];
const errorStatusMap = { ...COMMON_ERROR_STATUS_MAP, ...errorStatus };
const interceptors = [traceErrors];
const rpc = new RPCHandler<WebContext>(router, {
  plugins: [new ResponseHeadersHandlerPlugin()],
  errorStatusMap,
  interceptors,
});
const rest = new OpenAPIHandler<WebContext>(router, {
  plugins: [...plugins, new ResponseHeadersHandlerPlugin()],
  errorStatusMap,
  interceptors,
});
const registrar = new McpRegistrar(router, { converters, plugins, filter: anyoneCanCall });

let spec: Promise<string> | undefined;

const specResponse = async (): Promise<Response> => {
  spec ??= new OpenAPIGenerator({ converters })
    .generate(router, {
      base: { info: { title: "Stargrep", version: "1.0.0" }, servers: [{ url: "/api" }], security: [] },
      errorStatusMap,
      filter: anyoneCanCall,
    })
    .then((document) => JSON.stringify(document));
  return new Response(await spec, { headers: { "content-type": "application/json" } });
};

const matched = ({ response }: { readonly response?: Response | undefined }) => response;

// JSON-RPC lets an error carry data, so a protocol error from the MCP transport, such as a parse error, gets the trace ID.
const withJsonRpcTraceId = (body: string, traceId: string) => {
  const message: unknown = JSON.parse(body);
  if (!Predicate.isObject(message) || !Predicate.isObject(message.error)) return body;
  const data = Predicate.isObject(message.error.data) ? message.error.data : {};
  return "traceId" in data
    ? body
    : JSON.stringify({ ...message, error: { ...message.error, data: { ...data, traceId } } });
};

const answerMcp = async (request: Request, context: WebContext) => {
  const mcp = createMcpHandler(
    async () => {
      const server = new McpServer({ name: "stargrep", version: "1.0.0" });
      await registrar.register(server, { context });
      return server;
    },
    { responseMode: "json" },
  );
  const response = await mcp.fetch(request);
  // The request scope closes the database pool once this resolves, so a streamed body must be read first.
  const body = await response.text();
  if (!response.headers.get("content-type")?.startsWith("application/json")) return new Response(body, response);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const { status, statusText } = response;
  return new Response(withJsonRpcTraceId(body, context.requestTraceId), { status, statusText, headers });
};

type ServerError = ORPCError<WireCode, { readonly traceId: string }>;

const noRoute = (traceId: string): ServerError => wireError("NOT_FOUND", traceId);

const statusOf = (error: ServerError) => errorStatus[error.code];

const rpcSerializer = new RPCSerializer();

const restError = (error: ServerError) => Response.json(error.toJSON(), { status: statusOf(error) });

const rpcError = (error: ServerError) =>
  Response.json(rpcSerializer.serialize(error.toJSON()), { status: statusOf(error) });

type JsonRpcId = { readonly id?: string | number };

const jsonRpcIdOf = (message: unknown): JsonRpcId => {
  if (!Predicate.isObject(message)) return {};
  const { id } = message;
  return Predicate.isString(id) || (Predicate.isNumber(id) && Number.isInteger(id)) ? { id } : {};
};

// -32000 is in JSON-RPC's range for server-defined errors and -32603 is its internal error. A reply to a request whose
// ID is unknown leaves out id, because the pinned MCP JSONRPCMessageSchema accepts that and rejects a null ID.
const mcpError = (error: ServerError, id: JsonRpcId = {}) =>
  Response.json(
    {
      jsonrpc: "2.0",
      ...id,
      error: { code: error.code === "NOT_FOUND" ? -32000 : -32603, message: error.message, data: error.data },
    },
    { status: statusOf(error) },
  );

const mcpNoRoute = async (request: Request, traceId: string) =>
  mcpError(noRoute(traceId), jsonRpcIdOf(await request.json().catch(() => undefined)));

interface Route {
  readonly transport: Transport;
  readonly matches: (pathname: string) => boolean;
  readonly answer: (request: Request, context: WebContext) => Promise<Response | undefined>;
  readonly fail: (error: ServerError) => Response;
}

const under = (prefix: string) => (pathname: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

const routes: ReadonlyArray<Route> = [
  {
    transport: "rest",
    matches: (pathname) => pathname === "/openapi.json",
    answer: specResponse,
    fail: restError,
  },
  {
    transport: "rpc",
    matches: under("/rpc"),
    answer: (request, context) => rpc.handle(request, { prefix: "/rpc", context }).then(matched),
    fail: rpcError,
  },
  {
    transport: "rest",
    matches: under("/api"),
    answer: (request, context) => rest.handle(request, { prefix: "/api", context }).then(matched),
    fail: restError,
  },
  {
    transport: "mcp",
    matches: under("/mcp"),
    answer: (request, context) =>
      new URL(request.url).pathname === "/mcp"
        ? answerMcp(request, context)
        : mcpNoRoute(request, context.requestTraceId),
    fail: (error) => mcpError(error),
  },
];

interface RequestOptions {
  readonly transport: Transport;
  readonly layer: Layer.Layer<ApiServices, { readonly _tag: string }>;
  readonly requestTraceId: string;
  readonly publicConfig: PublicConfig;
  readonly answerCache: AnswerCache;
  readonly background: ApiContext["background"];
}

export const requestContext = Effect.fn("Web.requestContext")(function* (options: RequestOptions) {
  return {
    "effect/context": yield* Effect.context<never>(),
    transport: options.transport,
    publicConfig: options.publicConfig,
    procedureTime: yield* Ref.make(Option.none<Duration.Duration>()),
    serviceLayer: Layer.effectContext(
      Layer.build(options.layer).pipe(Effect.mapError((error) => new ApiServicesUnavailable({ failure: error._tag }))),
    ),
    execution: "request",
    answerCache: options.answerCache,
    background: options.background,
    requestTraceId: options.requestTraceId,
  } satisfies WebContext;
});

const withTiming = (
  response: Response,
  traceId: string,
  total: number,
  procedure: Option.Option<Duration.Duration>,
) => {
  const timed = new Response(response.body, response);
  timed.headers.set("x-trace-id", traceId);
  timed.headers.set(
    "server-timing",
    [
      `total;dur=${total}`,
      ...Option.match(procedure, { onNone: () => [], onSome: (api) => [`api;dur=${Duration.toMillis(api)}`] }),
    ].join(", "),
  );
  return timed;
};

export interface ServerOptions {
  readonly layerFor: RequestLayer;
  readonly tracer: Layer.Layer<never>;
  // Read on the first request, because TanStack Start's dev server loads the entry before env is set.
  readonly publicConfig: () => PublicConfig;
  readonly answerCache: (request: Request) => AnswerCache;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

const refreshTimeout = Duration.seconds(25);

// Work that outlives the response builds its own services, because the request's services close when it returns.
const background =
  (options: ServerOptions, request: Request): ApiContext["background"] =>
  (run) =>
    Effect.sync(() =>
      options.waitUntil(
        Effect.runPromise(
          run.pipe(
            Effect.provide(options.layerFor(request)),
            Effect.timeout(refreshTimeout),
            Effect.catchCause((cause) =>
              Effect.logWarning("Background work failed", { failure: Cause.hasDies(cause) ? "defect" : "failure" }),
            ),
            Effect.withSpan("Web.background"),
            Effect.provide(options.tracer),
          ),
        ),
      ),
    );

const respond = (route: Route, request: Request, options: ServerOptions) =>
  Effect.useSpan(`Web.${route.transport}`, { kind: "server" }, (span) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const context = yield* requestContext({
        transport: route.transport,
        layer: options.layerFor(request),
        requestTraceId: span.traceId,
        publicConfig: options.publicConfig(),
        answerCache: options.answerCache(request),
        background: background(options, request),
      });
      const response =
        (yield* Effect.promise(() => route.answer(request, context))) ?? route.fail(noRoute(span.traceId));
      const total = (yield* Clock.currentTimeMillis) - started;
      return withTiming(response, span.traceId, total, yield* Ref.get(context.procedureTime));
    }).pipe(
      Effect.scoped,
      Effect.withParentSpan(span),
      Effect.catchCause((cause) =>
        Effect.logError("Web request failed outside the API", {
          transport: route.transport,
          traceId: span.traceId,
          failure: Cause.hasDies(cause) ? "defect" : "interrupt",
        }).pipe(
          Effect.as(route.fail(wireError("INTERNAL_SERVER_ERROR", span.traceId))),
          Effect.tap((response) => Effect.sync(() => response.headers.set("x-trace-id", span.traceId))),
        ),
      ),
    ),
  );

export type AuthLayer = (request: Request) => Option.Option<Layer.Layer<Auth.Auth, { readonly _tag: string }>>;

const signInUnavailable = (traceId: string) => restError(wireError("SIGN_IN_UNAVAILABLE", traceId));

const respondAuth = (request: Request, layerFor: AuthLayer) =>
  Effect.useSpan("Web.auth", { kind: "server" }, (span) =>
    Option.match(layerFor(request), {
      onNone: () => Effect.succeed(signInUnavailable(span.traceId)),
      onSome: (layer) =>
        Auth.Auth.use((auth) => auth.handle(request)).pipe(Effect.provide(layer), Effect.withParentSpan(span)),
    }).pipe(
      Effect.map((response) => {
        const traced = new Response(response.body, response);
        traced.headers.set("x-trace-id", span.traceId);
        return traced;
      }),
      Effect.catchCause((cause) =>
        Effect.logError("Sign-in request failed", {
          traceId: span.traceId,
          failure: Cause.hasDies(cause) ? "defect" : "failure",
        }).pipe(
          Effect.as(
            Response.json(wireError("INTERNAL_SERVER_ERROR", span.traceId).toJSON(), {
              status: errorStatus.INTERNAL_SERVER_ERROR,
              headers: { "x-trace-id": span.traceId },
            }),
          ),
        ),
      ),
    ),
  );

export const makeAuthServer =
  (layerFor: AuthLayer, tracer: Layer.Layer<never>) =>
  (request: Request): Promise<Response> | undefined =>
    under(Auth.basePath)(new URL(request.url).pathname)
      ? Effect.runPromise(respondAuth(request, layerFor).pipe(Effect.provide(tracer)))
      : undefined;

export const makeServer =
  (options: ServerOptions) =>
  (request: Request): Promise<Response> | undefined => {
    const pathname = new URL(request.url).pathname;
    const route = routes.find((candidate) => candidate.matches(pathname));
    if (route === undefined) return undefined;
    return Effect.runPromise(respond(route, request, options).pipe(Effect.provide(options.tracer)));
  };
