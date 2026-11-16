import { describe, expect, test } from "bun:test";
import type { AnswerCache } from "@stargrep/api/answer-cache";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { FirstAnswer } from "../src/lib/page-data.ts";
import { now } from "../src/lib/present.ts";
import { libraryRevision } from "../src/lib/sync-status.ts";
import { type Computed, cachedFirstAnswer, firstAnswerKey } from "../src/server/first-answers.ts";
import { syncStatus } from "./sync-status.fixture.ts";

const minute = 60_000;

const answer = (query: string) => ({ query }) as unknown as FirstAnswer;

// A store that keeps what is written to it, by key, the way the answer cache does.
const storeOf = () => {
  const kept = new Map<string, string>();
  const store: AnswerCache = {
    get: (key) =>
      Effect.sync(() => {
        const body = kept.get(key);
        return body === undefined ? Option.none() : Option.some({ storedAt: now(), body });
      }),
    set: (key, body) => Effect.sync(() => void kept.set(key, body)),
    delete: (key) => Effect.sync(() => void kept.delete(key)),
  };
  const searchedAt = (key: string) => JSON.parse(kept.get(key) ?? "null")?.searchedAt as number | undefined;
  const put = (key: string, query: string, searchedMinutesAgo: number) =>
    kept.set(key, JSON.stringify({ first: answer(query), searchedAt: now() - searchedMinutesAgo * minute }));
  return { store, kept, searchedAt, put };
};

// A first answer built from a search answer the API stored some minutes ago.
const computing = (query: string, searchedMinutesAgo = 0, keep = true) => {
  const calls: Array<string> = [];
  return {
    calls,
    compute: async (): Promise<Computed> => {
      calls.push(query);
      return { first: answer(query), searchedAt: now() - searchedMinutesAgo * minute, keep };
    },
  };
};

const run = (store: AnswerCache, key: string, compute: () => Promise<Computed>) => {
  const background: Array<Promise<unknown>> = [];
  const result = cachedFirstAnswer({ store, key, compute, background: (work) => void background.push(work) });
  return { result, background };
};

describe("the landing's cached first answer", () => {
  test("serves an answer whose search answer is still fresh, without reading the library again", async () => {
    const { store, put } = storeOf();
    put("key", "stored", 4);
    const { calls, compute } = computing("computed");
    const { result, background } = run(store, "key", compute);
    expect(await result).toEqual({ first: answer("stored"), outcome: "hit" });
    expect([calls, background]).toEqual([[], []]);
  });

  test("goes stale when its search answer does, and refreshes once in the background", async () => {
    const { store, put, kept } = storeOf();
    put("key", "stored", 6);
    const { calls, compute } = computing("refreshed");
    const first = run(store, "key", compute);
    const second = run(store, "key", compute);
    expect(await first.result).toEqual({ first: answer("stored"), outcome: "stale" });
    expect(await second.result).toEqual({ first: answer("stored"), outcome: "stale" });
    await Promise.all([...first.background, ...second.background]);
    expect(calls).toEqual(["refreshed"]);
    expect(JSON.parse(kept.get("key") ?? "").first).toEqual(answer("refreshed"));
  });

  test("keeps the search answer's own time, so an answer the API served stale is never kept as fresh", async () => {
    const { store, searchedAt } = storeOf();
    const stale = computing("from a stale search", 6);
    const built = await run(store, "key", stale.compute).result;
    expect(built).toEqual({ first: answer("from a stale search"), outcome: "stale" });
    expect(now() - (searchedAt("key") ?? now())).toBeGreaterThanOrEqual(6 * minute);

    const later = computing("refreshed");
    const next = run(store, "key", later.compute);
    expect((await next.result).outcome).toBe("stale");
    await Promise.all(next.background);
    expect(later.calls).toEqual(["refreshed"]);
  });

  test("ends its freshness when the search answer's ends, not five minutes after it was built", async () => {
    const { store, searchedAt } = storeOf();
    const aging = computing("from an aging search", 4);
    expect((await run(store, "key", aging.compute).result).outcome).toBe("miss");
    const age = now() - (searchedAt("key") ?? Number.NaN);
    expect(age >= 4 * minute && age < 5 * minute).toBe(true);
  });

  test("computes and keeps an answer it has not stored, or one whose search answer is over a day old", async () => {
    for (const age of [undefined, 25 * 60]) {
      const { store, put, kept } = storeOf();
      if (age !== undefined) put("key", "stored", age);
      const { compute } = computing("computed");
      expect(await run(store, "key", compute).result).toEqual({ first: answer("computed"), outcome: "miss" });
      expect(JSON.parse(kept.get("key") ?? "").first).toEqual(answer("computed"));
    }
  });

  test("never keeps an answer the planner could not plan", async () => {
    const { store, kept } = storeOf();
    const { compute } = computing("fallback", 0, false);
    expect((await run(store, "key", compute).result).outcome).toBe("miss");
    expect(kept.size).toBe(0);
  });

  test("answers again once a sync or a newly read star changes the library revision", async () => {
    const reading = { total: 3, read: 2, failed: 0, queued: 0 };
    const revisions = [
      syncStatus({ syncedAt: "2026-11-07T00:00:00.000Z", enrichment: reading }),
      syncStatus({ syncedAt: "2026-11-07T00:01:00.000Z", enrichment: reading }),
      syncStatus({ syncedAt: "2026-11-07T00:00:00.000Z", enrichment: { total: 3, read: 3, failed: 0, queued: 0 } }),
    ].map(libraryRevision);
    expect(new Set(revisions).size).toBe(3);
    expect(libraryRevision(syncStatus({ syncedAt: "2026-11-07T00:00:00.000Z", enrichment: reading }))).toBe(
      revisions[0] as string,
    );

    const { store } = storeOf();
    const keyed = (revision: string) => firstAnswerKey("build", "stefanofa", revision, "terminal", "best");
    const before = computing("before");
    await run(store, keyed(revisions[0] as string), before.compute).result;
    const after = computing("after");
    expect(await run(store, keyed(revisions[1] as string), after.compute).result).toEqual({
      first: answer("after"),
      outcome: "miss",
    });
  });
});
