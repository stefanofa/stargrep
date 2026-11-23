import * as AnswerCache from "@stargrep/api/answer-cache";
import { defaultPublicConfig } from "@stargrep/api/public-config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeServer, type RequestLayer, type ServerOptions } from "../src/server/serve.ts";

// A server with the default settings, no answer cache, and background work left unawaited.
export const testServer = (layerFor: RequestLayer, options: Partial<ServerOptions> = {}) =>
  makeServer({
    layerFor,
    tracer: Layer.empty,
    analytics: () => Layer.empty,
    publicConfig: () => defaultPublicConfig,
    answerCache: () => AnswerCache.disabled,
    waitUntil: () => undefined,
    ...options,
  });

// Drops work meant for after the response, as testServer's waitUntil does.
export const afterResponse = () => Effect.void;
