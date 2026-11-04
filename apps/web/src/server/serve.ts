import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { EffectSchemaToJsonSchemaConverter } from "@orpc/effect";
import { SmartCoercionHandlerPlugin } from "@orpc/json-schema";
import { McpRegistrar } from "@orpc/mcp";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { COMMON_ERROR_STATUS_MAP, ORPCError, RPCSerializer } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { StandardHandlerInterceptor } from "@orpc/server/standard";
import { signedIn } from "@stargrep/api/contract";
import { errorStatus, wireError, withTraceId } from "@stargrep/api/errors";
import type { Transport } from "@stargrep/api/middleware/instrumentation";
import { type ApiContext, type ApiServices, ApiServicesUnavailable, router } from "@stargrep/api/router";
import * as Auth from "@stargrep/auth/auth";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

export type RequestLayer = (request: Request) => Layer.Layer<ApiServices, { readonly _tag: string }>;

interface WebContext extends ApiContext {
  readonly requestTraceId: string;
}

const malformed =
  "Malformed request. Ensure the request body is properly formatted and the 'Content-Type' header is set correctly.";

// oRPC decodes the body before any procedure middleware runs, so a body it cannot decode gets the request's trace ID here.
const traceErrors: StandardHandlerInterceptor<WebContext> = async (options) => {
  const decodeInput = () =>
    options.decodeInput().catch((cause: unknown) => {
      throw cause instanceof ORPCError ? cause : new ORPCError("BAD_REQUEST", { message: malformed, cause });
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
const rpc = new RPCHandler<WebContext>(router, { errorStatusMap, interceptors });
const rest = new OpenAPIHandler<WebContext>(router, { plugins, errorStatusMap, interceptors });
const anyoneCanCall = (_: unknown, path: ReadonlyArray<string>) => !signedIn.has(path.join("."));
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

type ServerError = ORPCError<string, { readonly traceId: string }>;

const noRoute = (traceId: string): ServerError =>
  new ORPCError("NOT_FOUND", { message: "Stargrep has no route for this method and path.", data: { traceId } });

const statusOf = (error: ServerError) => (error.code === "NOT_FOUND" ? 404 : 500);

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

export const requestContext = Effect.fn("Web.requestContext")(function* (
  transport: Transport,
  layer: Layer.Layer<ApiServices, { readonly _tag: string }>,
  requestTraceId: string,
) {
  const scope = yield* Scope.Scope;
  const services = yield* Effect.cached(
    Layer.build(layer).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError((error) => new ApiServicesUnavailable({ failure: error._tag })),
    ),
  );
  return {
    "effect/context": yield* Effect.context<never>(),
    transport,
    procedureTime: yield* Ref.make(Option.none<Duration.Duration>()),
    services,
    requestTraceId,
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

const respond = (route: Route, request: Request, layerFor: RequestLayer) =>
  Effect.useSpan(`Web.${route.transport}`, { kind: "server" }, (span) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const context = yield* requestContext(route.transport, layerFor(request), span.traceId);
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

const signInUnavailable = (traceId: string) =>
  Response.json(
    { code: "SIGN_IN_UNAVAILABLE", message: "This stage has no GitHub App to sign in with.", data: { traceId } },
    { status: 503 },
  );

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
              status: 500,
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
  (layerFor: RequestLayer, tracer: Layer.Layer<never>) =>
  (request: Request): Promise<Response> | undefined => {
    const pathname = new URL(request.url).pathname;
    const route = routes.find((candidate) => candidate.matches(pathname));
    if (route === undefined) return undefined;
    return Effect.runPromise(respond(route, request, layerFor).pipe(Effect.provide(tracer)));
  };
