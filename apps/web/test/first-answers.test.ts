import { describe, expect, test } from "bun:test";
import type { AnswerCache } from "@stargrep/api/answer-cache";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { FirstAnswer } from "../src/lib/page-data.ts";
import { now } from "../src/lib/present.ts";
import { type Computed, cachedFirstAnswer } from "../src/server/first-answers.ts";

const minute = 60_000;

const answer = (query: string) => ({ query }) as unknown as FirstAnswer;

// A store holding one answer stored some minutes ago, which records what is written to it.
const storeWith = (storedMinutesAgo: number | undefined, query = "stored") => {
  const written: Array<string> = [];
  const store: AnswerCache = {
    get: () =>
      Effect.succeed(
        storedMinutesAgo === undefined
          ? Option.none()
          : Option.some({ storedAt: now() - storedMinutesAgo * minute, body: JSON.stringify(answer(query)) }),
      ),
    set: (_key, body) => Effect.sync(() => void written.push(JSON.parse(body).query)),
  };
  return { store, written };
};

const computing = (query: string, keep = true) => {
  const calls: Array<string> = [];
  return {
    calls,
    compute: async (): Promise<Computed> => {
      calls.push(query);
      return { first: answer(query), keep };
    },
  };
};

const run = (store: AnswerCache, key: string, compute: () => Promise<Computed>) => {
  const background: Array<Promise<unknown>> = [];
  const result = cachedFirstAnswer({ store, key, compute, background: (work) => void background.push(work) });
  return { result, background };
};

describe("the landing's cached first answer", () => {
  test("serves a fresh answer without reading the library again", async () => {
    const { store } = storeWith(2);
    const { calls, compute } = computing("fresh");
    const { result, background } = run(store, "fresh-key", compute);
    expect(await result).toEqual({ first: answer("stored"), outcome: "hit" });
    expect(calls).toEqual([]);
    expect(background).toEqual([]);
  });

  test("serves a stale answer at once and refreshes it once in the background", async () => {
    const { store, written } = storeWith(30);
    const { calls, compute } = computing("refreshed");
    const first = run(store, "stale-key", compute);
    const second = run(store, "stale-key", compute);
    expect(await first.result).toEqual({ first: answer("stored"), outcome: "stale" });
    expect(await second.result).toEqual({ first: answer("stored"), outcome: "stale" });
    await Promise.all([...first.background, ...second.background]);
    expect(calls).toEqual(["refreshed"]);
    expect(written).toEqual(["refreshed"]);
  });

  test("computes and keeps an answer it has not stored, or stored over a day ago", async () => {
    for (const age of [undefined, 25 * 60]) {
      const { store, written } = storeWith(age);
      const { compute } = computing("computed");
      expect(await run(store, `missing-${age}`, compute).result).toEqual({
        first: answer("computed"),
        outcome: "miss",
      });
      expect(written).toEqual(["computed"]);
    }
  });

  test("never keeps an answer the planner could not plan", async () => {
    const { store, written } = storeWith(undefined);
    const { compute } = computing("fallback", false);
    expect((await run(store, "fallback-key", compute).result).outcome).toBe("miss");
    expect(written).toEqual([]);
  });
});
