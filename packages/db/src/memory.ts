import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { GitHubAccountId, RepoId } from "./ids.ts";
import type { Account } from "./queries/accounts.ts";
import type { StoredRepo } from "./queries/repos.ts";
import type { Star } from "./queries/stars.ts";
import type { UsageCounts } from "./queries/usage.ts";

export interface Tables {
  readonly accounts: Map<GitHubAccountId, Account>;
  readonly repos: Map<RepoId, StoredRepo>;
  readonly stars: Map<string, Star>;
  readonly usage: Map<string, UsageCounts>;
}

export const starKey = (accountId: GitHubAccountId, repoId: RepoId) => `${accountId}/${repoId}`;

export class MemoryStore extends Context.Service<
  MemoryStore,
  {
    readonly tables: Tables;
    readonly withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("@stargrep/db/memory/MemoryStore") {}

const restore = <K, V>(table: Map<K, V>, snapshot: ReadonlyMap<K, V>) => {
  table.clear();
  for (const [key, value] of snapshot) table.set(key, value);
};

const InTransaction = Context.Reference<boolean>("@stargrep/db/memory/InTransaction", {
  defaultValue: () => false,
});

const make = Effect.sync(() => {
  const tables: Tables = { accounts: new Map(), repos: new Map(), stars: new Map(), usage: new Map() };

  const withTransaction = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    if (yield* InTransaction) return yield* effect;
    const snapshot = {
      accounts: new Map(tables.accounts),
      repos: new Map(tables.repos),
      stars: new Map(tables.stars),
      usage: new Map(tables.usage),
    };
    return yield* effect.pipe(
      Effect.provideService(InTransaction, true),
      Effect.onError(() =>
        Effect.sync(() => {
          restore(tables.accounts, snapshot.accounts);
          restore(tables.repos, snapshot.repos);
          restore(tables.stars, snapshot.stars);
          restore(tables.usage, snapshot.usage);
        }),
      ),
    );
  });

  return MemoryStore.of({ tables, withTransaction });
});

export const layer = Layer.effect(MemoryStore, make);
