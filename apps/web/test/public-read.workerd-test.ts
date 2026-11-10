import { exports } from "cloudflare:workers";
import { Caller } from "@stargrep/api/caller";
import { GitHubLogin } from "@stargrep/api/contract";
import { IconHost } from "@stargrep/api/icon-host";
import { defaultPublicConfig } from "@stargrep/api/public-config";
import { RateLimiter } from "@stargrep/api/rate-limiter";
import type { ApiServices } from "@stargrep/api/services";
import { NotSignedIn, Viewers } from "@stargrep/api/viewers";
import { QueryPlan, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { makeDb } from "@stargrep/db/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { answerUrl, makeAnswerCache } from "../src/server/answer-cache.ts";
import { repo } from "./entry.ts";
import { testServer } from "./serve.ts";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read as untyped JSON in these tests.
type Json = any;

const post = (input: object, ip = "192.0.2.1"): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": ip },
  body: JSON.stringify(input),
});

let nextCache = 0;

describe("the demo answer cache on the Cache API", () => {
  const fixture = () => {
    const counts = { builds: 0, released: 0, searches: 0 };
    const pending: Array<Promise<unknown>> = [];

    const search = Layer.effect(
      Search.Search,
      Effect.gen(function* () {
        const scope = { closed: false };
        counts.builds++;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            scope.closed = true;
            counts.released++;
          }),
        );
        return Search.Search.of({
          search: (request) =>
            scope.closed
              ? Effect.die("searched with services whose request already returned")
              : Effect.sync(() => {
                  counts.searches++;
                  return {
                    plan: QueryPlan.asTyped(request.query, "sentence"),
                    planSource: "model",
                    results: [
                      {
                        repo,
                        nameMatch: false,
                        textRank: 1,
                        vectorRank: 1,
                        metrics: [{ metric: "stars", value: counts.searches }],
                      },
                    ],
                    applied: [],
                  } satisfies Search.SearchOutcome;
                }),
        });
      }),
    );

    const layerFor = (request: Request): Layer.Layer<ApiServices> =>
      Layer.mergeAll(
        search,
        Layer.succeed(Db.Db, makeDb({})),
        Layer.mock(SyncRequests.SyncRequests, {}),
        Layer.succeed(RateLimiter, RateLimiter.of({ acquire: () => Effect.void })),
        Layer.succeed(Viewers, Viewers.of({ current: Effect.fail(new NotSignedIn()), signedIn: Effect.succeedNone })),
        Layer.succeed(IconHost, IconHost.of({ origin: new URL(request.url).origin })),
        Layer.succeed(Caller, Caller.of({ key: Db.CallerKey.make("caller-test"), address: "192.0.2.1" })),
      );

    const cacheName = `answers-test-${++nextCache}`;
    const cache = () => caches.open(cacheName);
    const serve = testServer(layerFor, {
      publicConfig: () => ({ ...defaultPublicConfig, demoLogin: GitHubLogin.make("ada") }),
      answerCache: makeAnswerCache(cache),
      waitUntil: (promise) => pending.push(promise),
    });

    const ask = async (input: object) => {
      const response = await serve(new Request("http://web/api/search", post(input)));
      if (response === undefined) throw new Error("no route for /api/search");
      const body: Json = await response.json();
      return {
        status: response.status,
        cache: response.headers.get("x-answer-cache"),
        stars: body.results[0].metrics[0].value,
      };
    };

    return { counts, pending, ask, cache };
  };

  const demo = { scope: { kind: "stars", login: "ada" }, q: "terminal dashboards" };
  const url = answerUrl("http://web", "search/ada/stars/20/terminal dashboards");

  it("stores a demo answer and serves it without building services", async () => {
    const { counts, ask, cache } = fixture();
    expect(await ask(demo)).toEqual({ status: 200, cache: "miss", stars: 1 });
    expect(await ask({ scope: { kind: "stars", login: "Ada" }, q: "Terminal  dashboards" })).toEqual({
      status: 200,
      cache: "hit",
      stars: 1,
    });
    expect(counts).toEqual({ builds: 1, released: 1, searches: 1 });
    const stored = await (await cache()).match(url);
    expect(stored?.headers.get("cache-control")).toBe("s-maxage=86700");
  });

  it("serves a stale answer at once and replaces it after waitUntil settles, with services of its own", async () => {
    const { counts, pending, ask, cache } = fixture();
    await ask(demo);
    const answers = await cache();
    const stored = await answers.match(url);
    if (stored === undefined) throw new Error("the demo answer was not stored");
    const sixMinutesEarlier = String(Number(stored.headers.get("x-stored-at")) - 6 * 60_000);
    const headers = new Headers(stored.headers);
    headers.set("x-stored-at", sixMinutesEarlier);
    await answers.put(url, new Response(await stored.text(), { headers }));

    expect(await ask(demo)).toEqual({ status: 200, cache: "stale", stars: 1 });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(counts).toEqual({ builds: 2, released: 2, searches: 2 });
    expect(await ask(demo)).toEqual({ status: 200, cache: "hit", stars: 2 });
  });

  it("never caches another login's search", async () => {
    const { ask } = fixture();
    expect((await ask({ scope: { kind: "stars", login: "grace" }, q: "terminal dashboards" })).cache).toBeNull();
    expect((await ask({ scope: { kind: "stars", login: "grace" }, q: "terminal dashboards" })).cache).toBeNull();
  });
});

describe("browser caching", () => {
  it("keeps config for 5 minutes and a page of stars for 10 seconds, but never an error", async () => {
    const config = await exports.default.fetch(new Request("http://web/api/config"));
    expect(config.headers.get("cache-control")).toBe("public, max-age=300");

    const stars = await exports.default.fetch(new Request("http://web/api/stars/ada"));
    const page: Json = await stars.json();
    expect([stars.status, stars.headers.get("cache-control")]).toEqual([200, "public, max-age=10"]);
    expect(page).toMatchObject({ login: "ada", repos: [{ id: 42, read: true }], nextCursor: null });

    const unsynced = await exports.default.fetch(new Request("http://web/api/stars/grace"));
    const error: Json = await unsynced.json();
    expect([unsynced.status, error.code]).toEqual([404, "ACCOUNT_NOT_SYNCED"]);
    expect(unsynced.headers.get("cache-control")).toBeNull();
  });
});

describe("the search limit", () => {
  it("answers the 121st search in a minute from one network with 429, and still answers another network", async () => {
    const search = (ip: string) =>
      exports.default.fetch(
        new Request("http://web/api/search", post({ scope: { kind: "stars", login: "ada" }, q: "dashboards" }, ip)),
      );
    const statuses: Array<number> = [];
    for (let attempt = 0; attempt < 121; attempt++) statuses.push((await search("192.0.2.121")).status);
    expect(statuses.slice(0, 120).every((status) => status === 200)).toBe(true);
    const refused: Json = await (await search("192.0.2.121")).json();
    expect([statuses[120], refused.code]).toEqual([429, "TOO_MANY_REQUESTS"]);
    expect((await search("192.0.2.122")).status).toBe(200);
  });
});
