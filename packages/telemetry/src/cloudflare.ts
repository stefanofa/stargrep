import { layer as cloudflareTracer } from "@alchemy.run/cloudflare/Workers/CloudflareTracer";
import * as AlchemyTelemetry from "alchemy/Telemetry";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import { withoutResults } from "./tracer.ts";

export const tracer = Layer.effect(Tracer.Tracer, Effect.map(Effect.tracer, withoutResults)).pipe(
  Layer.provide(cloudflareTracer),
);

export const layer = AlchemyTelemetry.layer(tracer);
