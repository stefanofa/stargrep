import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { EffectSchemaToJsonSchemaConverter } from "@orpc/effect";
import { SmartCoercionHandlerPlugin } from "@orpc/json-schema";
import { McpRegistrar } from "@orpc/mcp";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { COMMON_ERROR_STATUS_MAP } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { errorStatus, errors } from "@stargrep/api/errors";
import type { Transport } from "@stargrep/api/middleware/instrumentation";
import { type ApiContext, type ApiServices, ApiServicesUnavailable, router } from "@stargrep/api/router";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

export interface Timing {
  search?: number;
}

export type RequestLayer<E extends { readonly _tag: string }> = (
  request: Request,
  timing: Timing,
) => Layer.Layer<ApiServices, E>;

type Route = Transport | "spec";

const routes: ReadonlyArray<readonly [Route, (pathname: string) => boolean]> = [
  ["rpc", (pathname) => pathname === "/rpc" || pathname.startsWith("/rpc/")],
  ["rest", (pathname) => pathname === "/api" || pathname.startsWith("/api/")],
  ["mcp", (pathname) => pathname === "/mcp"],
  ["spec", (pathname) => pathname === "/openapi.json"],
];

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

const notFound = () => new Response("Not found", { status: 404 });

const handleMcp = async (request: Request, context: ApiContext) => {
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

const dispatch = (transport: Transport, request: Request, context: ApiContext): Promise<Response> => {
  switch (transport) {
    case "rpc":
      return rpc.handle(request, { prefix: "/rpc", context }).then(({ response }) => response ?? notFound());
    case "rest":
      return rest.handle(request, { prefix: "/api", context }).then(({ response }) => response ?? notFound());
    case "mcp":
      return handleMcp(request, context);
  }
};

const withTiming = (response: Response, total: number, timing: Timing) => {
  const timed = new Response(response.body, response);
  timed.headers.set(
    "server-timing",
    [`total;dur=${total}`, ...(timing.search === undefined ? [] : [`search;dur=${timing.search}`])].join(", "),
  );
  return timed;
};

const failure = (traceId: string) =>
  Response.json(
    {
      defined: true,
      code: "INTERNAL_SERVER_ERROR",
      message: errors.INTERNAL_SERVER_ERROR.message,
      data: { traceId },
    },
    { status: errorStatus.INTERNAL_SERVER_ERROR },
  );

const respond = <E extends { readonly _tag: string }>(
  transport: Transport,
  request: Request,
  layerFor: RequestLayer<E>,
) =>
  Effect.useSpan(`Web.${transport}`, { kind: "server" }, (span) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const timing: Timing = {};
      const scope = yield* Scope.Scope;
      const services = yield* Effect.cached(
        Layer.build(layerFor(request, timing)).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError((error) => new ApiServicesUnavailable({ failure: error._tag })),
        ),
      );
      const context: ApiContext = { "effect/context": yield* Effect.context<never>(), transport, services };
      const response = yield* Effect.promise(() => dispatch(transport, request, context));
      return withTiming(response, (yield* Clock.currentTimeMillis) - started, timing);
    }).pipe(
      Effect.scoped,
      Effect.withParentSpan(span),
      Effect.catchCause((cause) =>
        Effect.logError("Web request failed outside the API", {
          transport,
          traceId: span.traceId,
          failure: Cause.hasDies(cause) ? "defect" : "interrupt",
        }).pipe(Effect.as(failure(span.traceId))),
      ),
    ),
  );

export const makeServer =
  <E extends { readonly _tag: string }>(layerFor: RequestLayer<E>, tracer: Layer.Layer<never>) =>
  (request: Request): Promise<Response> | undefined => {
    const pathname = new URL(request.url).pathname;
    const route = routes.find(([, matches]) => matches(pathname))?.[0];
    if (route === undefined) return undefined;
    if (route === "spec") return specResponse();
    return Effect.runPromise(respond(route, request, layerFor).pipe(Effect.provide(tracer)));
  };
