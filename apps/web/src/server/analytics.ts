import * as AnalyticsLayer from "@stargrep/runtime/analytics";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layerActor } from "./caller.ts";
import type { AnalyticsFor } from "./serve.ts";

// Off prod there is no sink, so the request's network is not worked out for analytics either. Background work, such as
// an answer refresh, names Stargrep.
export const layerAnalytics = (
  stage: string,
  callerSecret: string,
  background: (send: Effect.Effect<void>) => Effect.Effect<void>,
): AnalyticsFor => {
  if (!AnalyticsLayer.sends(stage)) return () => Layer.empty;
  const sink = AnalyticsLayer.layer(stage, background);
  return (request) => (request === undefined ? sink : Layer.merge(sink, layerActor(callerSecret, request)));
};
