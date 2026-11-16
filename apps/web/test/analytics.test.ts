import { describe, expect, test } from "bun:test";
import type { ApiServices } from "@stargrep/api/services";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { layerAnalytics } from "../src/server/analytics.ts";
import type { RequestLayer } from "../src/server/serve.ts";
import { testServer } from "./serve.ts";

interface Batch {
  readonly batch: ReadonlyArray<{ readonly event: string; readonly properties: Record<string, unknown> }>;
}

// A PostHog behind the analytics layer's fetch: one that records each batch, or one that refuses every request.
const postHog = (answer: "accept" | "refuse") => {
  const batches: Array<Batch> = [];
  const sends: Array<Promise<void>> = [];
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (answer === "refuse") throw new TypeError("fetch failed");
      const request = new Request(input, init);
      batches.push(await request.json());
      return new Response("{}");
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const background = (send: Effect.Effect<void>) =>
    Effect.sync(() => {
      sends.push(Effect.runPromise(send.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))));
    });
  return { batches, sends, background };
};

// Every API service fails to start, as when the database is down, so a search answers 503 and logs the failure.
const databaseDown: Effect.Effect<Context.Context<ApiServices>, { readonly _tag: string }> = Effect.fail({
  _tag: "DbQueryFailed",
});
const servicesDown: RequestLayer = () => Layer.effectContext(databaseDown);

const search = (stage: string, answer: "accept" | "refuse") => {
  const posthog = postHog(answer);
  const serve = testServer(servicesDown, { analytics: layerAnalytics(stage, "caller-secret", posthog.background) });
  const response = serve(
    new Request("https://stargrep.com/api/search", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" },
      body: JSON.stringify({ scope: { kind: "stars", login: "someone" }, q: "private words" }),
    }),
  );
  return { posthog, response };
};

describe("web analytics", () => {
  test("sends a failure the API logged to PostHog after the response, naming the network by a hash", async () => {
    const { posthog, response } = search("prod", "accept");
    expect((await response)?.status).toBe(503);
    await Promise.all(posthog.sends);
    const [exception] = posthog.batches.flatMap(({ batch }) => batch);
    expect(exception?.event).toBe("$exception");
    expect(exception?.properties).toMatchObject({
      source: "API call failed",
      stage: "prod",
      $exception_list: [{ type: "ApiServicesUnavailable" }],
    });
    expect(exception?.properties.distinct_id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(posthog.batches)).not.toContain("192.0.2.1");
    expect(JSON.stringify(posthog.batches)).not.toContain("private words");
  });

  test("answers the same when PostHog is down", async () => {
    const up = search("prod", "accept");
    const down = search("prod", "refuse");
    const [answered, failed] = await Promise.all([up.response, down.response]);
    expect(failed?.status).toBe(answered?.status);
    for (const response of [answered, failed]) expect(await response?.text()).toContain('"code":"SERVICE_UNAVAILABLE"');
    await Promise.all(down.posthog.sends);
    expect(down.posthog.batches).toEqual([]);
  });

  test("sends nothing from a preview or a local stage", async () => {
    for (const stage of ["pr-128", "local", ""]) {
      const { posthog, response } = search(stage, "accept");
      expect((await response)?.status).toBe(503);
      expect(posthog.sends).toEqual([]);
    }
  });
});
