import { type AnswerCache, claimRefresh, searchWindows } from "@stargrep/api/answer-cache";
import type { Sort } from "@stargrep/ui";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { FirstAnswer } from "../lib/page-data.ts";
import { now } from "../lib/present.ts";

const fresh = Duration.toMillis(searchWindows.fresh);
const servable = Duration.toMillis(Duration.sum(searchWindows.fresh, searchWindows.stale));
const refreshStarts = new Map<string, number>();

export interface Computed {
  readonly first: FirstAnswer;
  // When the API stored the search answer the first answer holds. The first answer is fresh exactly as long as that
  // answer is, so one the API served stale is never kept as fresh.
  readonly searchedAt: number;
  // An answer the planner could not plan is never kept, as the API never keeps its search answer.
  readonly keep: boolean;
}

interface Kept {
  readonly first: FirstAnswer;
  readonly searchedAt: number;
}

export type Outcome = "hit" | "stale" | "miss";

// The build keeps an older page model's answers apart, and the library revision keeps an older library's.
export const firstAnswerKey = (build: string, login: string, revision: string, query: string, sort: Sort) =>
  `first/${build}/${login}/${revision}/${query}/${sort}`;

// The demo's first answer is the same for every visitor of one library revision, which the key names. It follows the
// demo search answer's windows from when that answer was stored: served as is while fresh, then served while one
// refresh at a time builds it again.
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
  const keep = async ({ first, searchedAt, keep }: Computed) => {
    const left = searchedAt + servable - now();
    if (!keep || left <= 0) return false;
    const kept: Kept = { first, searchedAt };
    await Effect.runPromise(store.set(key, JSON.stringify(kept), Duration.millis(left)));
    return true;
  };
  const stored = await Effect.runPromise(store.get(key));
  const at = now();
  if (Option.isSome(stored)) {
    const kept = JSON.parse(stored.value.body) as Kept;
    if (at - kept.searchedAt < fresh) return { first: kept.first, outcome: "hit" };
    if (at - kept.searchedAt < servable) {
      if (claimRefresh(refreshStarts, key, at, searchWindows.fresh))
        background(
          compute()
            .then(keep)
            .then((stored) => stored && refreshStarts.delete(key))
            .catch((error: unknown) =>
              Effect.runPromise(Effect.logWarning("First answer refresh failed", { error: String(error) })),
            ),
        );
      return { first: kept.first, outcome: "stale" };
    }
  }
  const computed = await compute();
  await keep(computed);
  return { first: computed.first, outcome: at - computed.searchedAt < fresh ? "miss" : "stale" };
};
