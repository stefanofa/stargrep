import { describe, expect } from "bun:test";
import * as GitHubFake from "@stargrep/github/github.fixture";
import { effect } from "@stargrep/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import { repoStars } from "../src/server/repo-stars.ts";

// A location's cache that keeps what is put in it and records how long each entry may stay.
const cacheOf = (options: { readonly broken?: boolean } = {}) => {
  const kept = new Map<string, { readonly body: string; readonly cacheControl: string | null }>();
  const cache = {
    match: async (key: string) => {
      if (options.broken) throw new Error("cache unavailable");
      const entry = kept.get(key);
      return entry === undefined ? undefined : new Response(entry.body);
    },
    put: async (key: string, response: Response) => {
      if (options.broken) throw new Error("cache unavailable");
      kept.set(key, { body: await response.text(), cacheControl: response.headers.get("cache-control") });
    },
  } as unknown as Cache;
  return { cache: async () => cache, kept };
};

const setUp = (handler: GitHubFake.Handler, options: { readonly broken?: boolean } = {}) => {
  const github = GitHubFake.make(handler);
  const { cache, kept } = cacheOf(options);
  const background: Array<Promise<unknown>> = [];
  const store = {
    cache,
    waitUntil: (work: Promise<unknown>) => void background.push(work),
    renderWait: Duration.millis(750),
  };
  const read = repoStars("https://stargrep.com", store).pipe(Effect.provide(github.client));
  return { github, kept, background, read };
};

const settle = (background: ReadonlyArray<Promise<unknown>>) => Effect.promise(() => Promise.all(background));

describe("the header's GitHub star count", () => {
  effect("reads Stargrep's repo once, and the next page takes the count from the cache for an hour", () => {
    const { github, kept, background, read } = setUp(() => ({ body: { stargazers_count: 128 } }));
    return Effect.gen(function* () {
      expect(yield* read).toBe(128);
      yield* settle(background);
      expect(yield* read).toBe(128);
      expect(github.sent.map((sent) => sent.url.pathname)).toEqual(["/repos/stefanofa/stargrep"]);
      expect(github.sent[0]?.headers.authorization).toBeUndefined();
      expect([...kept.values()]).toEqual([{ body: "128", cacheControl: "s-maxage=3600" }]);
    });
  });

  effect("a GitHub that fails renders no count, and the cache keeps that for 10 minutes", () => {
    const { github, kept, background, read } = setUp(() => ({ status: 403, body: { message: "rate limited" } }));
    return Effect.gen(function* () {
      expect(yield* read).toBeNull();
      yield* settle(background);
      expect(yield* read).toBeNull();
      expect(github.sent).toHaveLength(1);
      expect([...kept.values()]).toEqual([{ body: "null", cacheControl: "s-maxage=600" }]);
    });
  });

  effect("a reply without a count, or a network failure, renders no count", () =>
    Effect.gen(function* () {
      expect(yield* setUp(() => ({ body: { stargazers_count: "many" } })).read).toBeNull();
      expect(yield* setUp(() => ({ transportError: "connection reset" })).read).toBeNull();
    }),
  );

  effect("a slow GitHub holds the page 750ms at most, and its answer still fills the cache for the next page", () => {
    const { cache, kept } = cacheOf();
    const background: Array<Promise<unknown>> = [];
    let requests = 0;
    const slowGitHub = HttpClient.make((request) =>
      Effect.sleep(Duration.seconds(2)).pipe(
        Effect.tap(() => Effect.sync(() => requests++)),
        Effect.as(HttpClientResponse.fromWeb(request, Response.json({ stargazers_count: 7 }))),
      ),
    );
    const store = {
      cache,
      waitUntil: (work: Promise<unknown>) => void background.push(work),
      renderWait: Duration.millis(750),
    };
    const read = repoStars("https://stargrep.com", store).pipe(
      Effect.provideService(HttpClient.HttpClient, slowGitHub),
    );
    return Effect.gen(function* () {
      const rendering = yield* Effect.forkChild(read);
      yield* TestClock.adjust(Duration.millis(750));
      expect(yield* Fiber.join(rendering)).toBeNull();
      yield* TestClock.adjust(Duration.seconds(2));
      yield* settle(background);
      expect([...kept.values()].map((entry) => entry.body)).toEqual(["7"]);
      expect(yield* read).toBe(7);
      expect(requests).toBe(1);
    });
  });

  effect("a cache that throws still renders the page, with whatever GitHub answers", () => {
    const { read } = setUp(() => ({ body: { stargazers_count: 42 } }), { broken: true });
    return Effect.gen(function* () {
      expect(yield* read).toBe(42);
    });
  });
});
