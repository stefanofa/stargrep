import { describe, expect } from "bun:test";
import { effect } from "@stargrep/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { repoStars, type StarsWorker } from "../src/server/repo-stars.ts";

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

// The main Worker's RPC method, answering what the test gives it and counting the asks.
const workerOf = (answer: () => Promise<unknown>) => {
  const asks = { count: 0 };
  const worker: StarsWorker = {
    stargrepStars: () => {
      asks.count += 1;
      return answer();
    },
  };
  return { worker, asks };
};

const setUp = (answer: () => Promise<unknown>, options: { readonly broken?: boolean } = {}) => {
  const { worker, asks } = workerOf(answer);
  const { cache, kept } = cacheOf(options);
  const background: Array<Promise<unknown>> = [];
  const read = repoStars("https://stargrep.com", {
    worker,
    cache,
    waitUntil: (work) => void background.push(work),
    renderWait: Duration.millis(750),
  });
  return { asks, kept, background, read };
};

const settle = (background: ReadonlyArray<Promise<unknown>>) => Effect.promise(() => Promise.all(background));

describe("the header's GitHub star count", () => {
  effect("asks the main Worker once, and the next page takes the count from the cache for an hour", () => {
    const { asks, kept, background, read } = setUp(async () => 128);
    return Effect.gen(function* () {
      expect(yield* read).toBe(128);
      yield* settle(background);
      expect(yield* read).toBe(128);
      expect(yield* read).toBe(128);
      expect(asks.count).toBe(1);
      expect([...kept.values()]).toEqual([{ body: "128", cacheControl: "s-maxage=3600" }]);
    });
  });

  effect("a main Worker without a count renders none, and the cache keeps that for 10 minutes", () => {
    const { asks, kept, background, read } = setUp(async () => null);
    return Effect.gen(function* () {
      expect(yield* read).toBeNull();
      yield* settle(background);
      expect(yield* read).toBeNull();
      expect(asks.count).toBe(1);
      expect([...kept.values()]).toEqual([{ body: "null", cacheControl: "s-maxage=600" }]);
    });
  });

  effect("a reply that is no count, or a call that throws, renders no count", () =>
    Effect.gen(function* () {
      expect(yield* setUp(async () => "many").read).toBeNull();
      expect(yield* setUp(async () => -3).read).toBeNull();
      expect(yield* setUp(() => Promise.reject(new Error("rpc failed"))).read).toBeNull();
    }),
  );

  effect("a slow answer holds the page 750ms at most, and still fills the cache for the next page", () => {
    const answer = Promise.withResolvers<unknown>();
    const { asks, kept, background, read } = setUp(() => answer.promise);
    return Effect.gen(function* () {
      const rendering = yield* Effect.forkChild(read);
      yield* TestClock.adjust(Duration.millis(750));
      expect(yield* Fiber.join(rendering)).toBeNull();
      answer.resolve(7);
      yield* settle(background);
      expect([...kept.values()].map((entry) => entry.body)).toEqual(["7"]);
      expect(yield* read).toBe(7);
      expect(asks.count).toBe(1);
    });
  });

  effect("a cache that throws still renders the page, with whatever the main Worker answers", () => {
    const { read } = setUp(async () => 42, { broken: true });
    return Effect.gen(function* () {
      expect(yield* read).toBe(42);
    });
  });
});
