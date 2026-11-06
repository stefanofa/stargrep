import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ApiServices, ApiServicesUnavailable } from "./router.ts";

export interface StoredAnswer {
  readonly storedAt: number;
  readonly body: string;
}

// Answers the router may serve without building the request's services. A read that fails is a miss, and a write that
// fails is dropped, so the cache can only make an answer faster, never fail it.
export interface AnswerCache {
  readonly get: (key: string) => Effect.Effect<Option.Option<StoredAnswer>>;
  readonly set: (key: string, body: string, keepFor: Duration.Duration) => Effect.Effect<void>;
  // Runs after the response, with services of its own, because the request's services close when it returns.
  readonly refresh: (key: string, run: Effect.Effect<void, never, ApiServices>) => Effect.Effect<void>;
}

export const disabled: AnswerCache = {
  get: () => Effect.succeedNone,
  set: () => Effect.void,
  refresh: () => Effect.void,
};

// Runs each refresh before refresh returns, so a TestClock test sees its write.
export const memory = (services: Effect.Effect<Context.Context<ApiServices>, ApiServicesUnavailable>) => {
  const entries = new Map<string, StoredAnswer & { readonly expiresAt: number }>();
  const refreshing = new Set<string>();
  const refreshes: Array<string> = [];
  const cache: AnswerCache = {
    get: (key) =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        Option.filter(Option.fromUndefinedOr(entries.get(key)), (entry) => entry.expiresAt > now),
      ),
    set: (key, body, keepFor) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        entries.set(key, { storedAt: now, body, expiresAt: now + Duration.toMillis(keepFor) });
      }),
    refresh: (key, run) =>
      Effect.suspend(() => {
        if (refreshing.has(key)) return Effect.void;
        refreshing.add(key);
        refreshes.push(key);
        return services.pipe(
          Effect.flatMap((context) => Effect.provideContext(run, context)),
          Effect.catch((error) => Effect.logWarning("Answer refresh could not start", { error: error._tag })),
          Effect.ensuring(Effect.sync(() => refreshing.delete(key))),
        );
      }),
  };
  return { cache, entries, refreshes };
};
