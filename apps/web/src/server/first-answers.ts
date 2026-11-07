import { type AnswerCache, claimRefresh } from "@stargrep/api/answer-cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { FirstAnswer } from "../lib/page-data.ts";
import { now } from "../lib/present.ts";

// The demo's first answer is the same for every visitor, so it keeps the demo search answer's policy: fresh for 5
// minutes, then served for up to a day while one refresh at a time runs in the background.
const fresh = Duration.minutes(5);
const keepFor = Duration.sum(fresh, Duration.days(1));
const refreshStarts = new Map<string, number>();

export interface Computed {
  readonly first: FirstAnswer;
  // An answer the planner could not plan is never kept, as the API never keeps its search answer.
  readonly keep: boolean;
}

export type Outcome = "hit" | "stale" | "miss";

export const cachedFirstAnswer = async ({
  store,
  key,
  compute,
  background,
}: {
  readonly store: AnswerCache;
  readonly key: string;
  readonly compute: () => Promise<Computed>;
  readonly background: (work: Promise<unknown>) => void;
}): Promise<{ readonly first: FirstAnswer; readonly outcome: Outcome }> => {
  const kept = async ({ first, keep }: Computed) => {
    if (keep) await Effect.runPromise(store.set(key, JSON.stringify(first), keepFor));
    return keep;
  };
  const stored = await Effect.runPromise(store.get(key));
  const at = now();
  if (Option.isSome(stored) && at - stored.value.storedAt < Duration.toMillis(keepFor)) {
    const first = JSON.parse(stored.value.body) as FirstAnswer;
    if (at - stored.value.storedAt < Duration.toMillis(fresh)) return { first, outcome: "hit" };
    if (claimRefresh(refreshStarts, key, at, fresh))
      background(
        compute()
          .then(kept)
          .then((stored) => stored && refreshStarts.delete(key))
          .catch((error: unknown) =>
            Effect.runPromise(Effect.logWarning("First answer refresh failed", { error: String(error) })),
          ),
      );
    return { first, outcome: "stale" };
  }
  const computed = await compute();
  await kept(computed);
  return { first: computed.first, outcome: "miss" };
};
