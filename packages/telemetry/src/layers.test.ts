import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import type * as Tracer from "effect/Tracer";
import * as Cloudflare from "./cloudflare.ts";
import * as Otlp from "./otlp.ts";

const canary = "PRIVATE_RESULT_CANARY";

const endedSpan = Effect.gen(function* () {
  let span: Tracer.Span | undefined;
  const value = yield* Effect.gen(function* () {
    span = yield* Effect.currentSpan;
    return canary;
  }).pipe(Effect.withSpan("Probe.run"));
  expect(value).toBe(canary);
  return span;
});

describe("tracer layers", () => {
  it.effect("the OTLP layer ends a successful span with no value and exports no result", () => {
    const payloads: Array<string> = [];
    const collector = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag === "Uint8Array") payloads.push(new TextDecoder().decode(request.body.body));
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      }),
    );
    const layer = Otlp.layer({
      url: "https://collector.invalid/v1/traces",
      resource: { serviceName: "telemetry-test" },
      exportInterval: "1 hour",
    }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(Layer.succeed(HttpClient.HttpClient, collector)));
    return Effect.gen(function* () {
      const span = yield* endedSpan;
      expect(span?.status._tag === "Ended" && span.status.exit).toEqual(Exit.void);
      yield* (yield* OtlpExporter.Flusher).flush;
      expect(payloads.join("\n")).toContain("Probe.run");
      expect(payloads.join("\n")).not.toContain(canary);
    }).pipe(Effect.provide(layer));
  });

  it.effect("the Cloudflare layer ends a successful span with no value", () =>
    Effect.gen(function* () {
      const span = yield* endedSpan;
      expect(span?.status._tag === "Ended" && span.status.exit).toEqual(Exit.void);
    }).pipe(Effect.provide(Cloudflare.tracer)),
  );
});
