import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpTracer from "effect/observability/OtlpTracer";
import * as Tracer from "effect/Tracer";
import { withoutResults } from "./tracer.ts";

export const layer = (options: Parameters<typeof OtlpTracer.make>[0]) =>
  OtlpTracer.make(options).pipe(
    Effect.map(withoutResults),
    Layer.effect(Tracer.Tracer),
    Layer.provideMerge(OtlpExporter.layerFlusher),
  );
