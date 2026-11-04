import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { EffectSchemaToJsonSchemaConverter } from "@orpc/effect";
import { SmartCoercionHandlerPlugin } from "@orpc/json-schema";
import { McpRegistrar } from "@orpc/mcp";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { COMMON_ERROR_STATUS_MAP } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { errorStatus } from "@stargrep/api/errors";
import type { Transport } from "@stargrep/api/middleware/instrumentation";
import { type ApiContext, type ApiServices, ApiServicesUnavailable, router } from "@stargrep/api/router";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

export type RequestLayer = (request: Request) => Layer.Layer<ApiServices, { readonly _tag: string }>;

const converters = [new EffectSchemaToJsonSchemaConverter({ cache: true })];
const plugins = [new SmartCoercionHandlerPlugin({ converters })];
const errorStatusMap = { ...COMMON_ERROR_STATUS_MAP, ...errorStatus };
const rpc = new RPCHandler(router, { errorStatusMap });
const rest = new OpenAPIHandler(router, { plugins, errorStatusMap });
const registrar = new McpRegistrar(router, { converters, plugins });

let spec: Promise<string> | undefined;

const specResponse = async () => {
  spec ??= new OpenAPIGenerator({ converters })
    .generate(router, {
      base: { info: { title: "Stargrep", version: "1.0.0" }, servers: [{ url: "/api" }], security: [] },
      errorStatusMap,
    })
    .then((document) => JSON.stringify(document));
  return new Response(await spec, { headers: { "content-type": "application/json" } });
};

const orNotFound = ({ response }: { readonly response?: Response | undefined }) =>
  response ?? new Response("Not found", { status: 404 });

const answerMcp = async (request: Request, context: ApiContext) => {
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
  return new Response(await response.arrayBuffer(), response);
};

interface Route {
  readonly transport: Transport;
  readonly matches: (pathname: string) => boolean;
  readonly answer: (request: Request, context: ApiContext) => Promise<Response>;
}

const under = (prefix: string) => (pathname: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

const routes: ReadonlyArray<Route> = [
  {
    transport: "rpc",
    matches: under("/rpc"),
    answer: (request, context) => rpc.handle(request, { prefix: "/rpc", context }).then(orNotFound),
  },
  {
    transport: "rest",
    matches: under("/api"),
    answer: (request, context) => rest.handle(request, { prefix: "/api", context }).then(orNotFound),
  },
  { transport: "mcp", matches: (pathname) => pathname === "/mcp", answer: answerMcp },
];

export const requestContext = Effect.fn("Web.requestContext")(function* (
  transport: Transport,
  layer: Layer.Layer<ApiServices, { readonly _tag: string }>,
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
  } satisfies ApiContext;
});

const withTiming = (response: Response, total: number, procedure: Option.Option<Duration.Duration>) => {
  const timed = new Response(response.body, response);
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
      const context = yield* requestContext(route.transport, layerFor(request));
      const response = yield* Effect.promise(() => route.answer(request, context));
      const total = (yield* Clock.currentTimeMillis) - started;
      return withTiming(response, total, yield* Ref.get(context.procedureTime));
    }).pipe(
      Effect.scoped,
      Effect.withParentSpan(span),
      Effect.catchCause((cause) =>
        Effect.logError("Web request failed outside the API", {
          transport: route.transport,
          traceId: span.traceId,
          failure: Cause.hasDies(cause) ? "defect" : "interrupt",
        }).pipe(
          Effect.as(new Response("Internal Server Error", { status: 500, headers: { "x-trace-id": span.traceId } })),
        ),
      ),
    ),
  );

export const makeServer =
  (layerFor: RequestLayer, tracer: Layer.Layer<never>) =>
  (request: Request): Promise<Response> | undefined => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/openapi.json") return specResponse();
    const route = routes.find((candidate) => candidate.matches(pathname));
    if (route === undefined) return undefined;
    return Effect.runPromise(respond(route, request, layerFor).pipe(Effect.provide(tracer)));
  };
