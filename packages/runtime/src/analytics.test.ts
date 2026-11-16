import { describe, expect } from "bun:test";
import * as Analytics from "@stargrep/analytics/analytics";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as AnalyticsLayer from "./analytics.ts";

// Every request a stage's layer would send, answered by a PostHog that accepts it.
const sendsFor = (stage: string) => {
  const urls: Array<string> = [];
  const fetch = Object.assign(
    (input: string | URL | Request) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(new Response("{}"));
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Analytics.capture(Analytics.Event.SignedUp());
      yield* Effect.logError("Enrich sweep failed", { error: "DbQueryFailed" });
    }).pipe(Effect.provide(AnalyticsLayer.layer(stage, (send) => send))),
  ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.as(urls));
};

describe("analytics by stage", () => {
  it.effect("prod sends its events to PostHog", () =>
    Effect.gen(function* () {
      expect(yield* sendsFor("prod")).toEqual(["https://us.i.posthog.com/batch/"]);
    }),
  );

  it.effect("a preview, a local stage, and a Worker without a stage send nothing", () =>
    Effect.gen(function* () {
      for (const stage of ["pr-128", "stefano", ""]) expect(yield* sendsFor(stage)).toEqual([]);
    }),
  );
});
