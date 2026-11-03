import { eq, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AccountNotFound, type DbQueryFailed, type DbRowInvalid } from "../errors.ts";
import { GitHubAccountId, Login } from "../ids.ts";
import * as Memory from "../memory.ts";
import * as Postgres from "../postgres.ts";
import { NullableTime, rowsDecoder } from "../rows.ts";
import { githubAccounts } from "../schema.ts";

export const Account = createSelectSchema(githubAccounts, {
  id: GitHubAccountId,
  login: Login,
  starsSyncedAt: NullableTime,
  starsFullSyncedAt: NullableTime,
});
export type Account = typeof Account.Type;

export type AccountFacts = Omit<Account, "claimedBy" | "starsEtag" | "starsSyncedAt" | "starsFullSyncedAt">;

export interface StarSync {
  readonly id: GitHubAccountId;
  readonly etag: string | null;
  readonly at: DateTime.Utc;
  readonly full: boolean;
}

export interface Queries {
  readonly upsert: (facts: AccountFacts) => Effect.Effect<void, DbQueryFailed>;
  readonly get: (id: GitHubAccountId) => Effect.Effect<Option.Option<Account>, DbQueryFailed | DbRowInvalid>;
  readonly recordStarSync: (sync: StarSync) => Effect.Effect<void, DbQueryFailed | AccountNotFound>;
}

const decodeAccounts = rowsDecoder(Account);

export const postgres = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;

  return {
    upsert: (facts) => {
      const { id: _, ...changes } = facts;
      return run("accounts.upsert", (db) =>
        db.insert(githubAccounts).values(facts).onConflictDoUpdate({ target: githubAccounts.id, set: changes }),
      );
    },
    get: (id) =>
      run("accounts.get", (db) => db.select().from(githubAccounts).where(eq(githubAccounts.id, id))).pipe(
        Effect.flatMap(decodeAccounts("accounts.get")),
        Effect.map(Arr.head),
      ),
    recordStarSync: (sync) => {
      const at = DateTime.toDateUtc(sync.at);
      return run("accounts.recordStarSync", (db) =>
        db
          .update(githubAccounts)
          .set({
            starsEtag: sync.etag,
            starsSyncedAt: at,
            starsFullSyncedAt: sync.full ? at : sql`${githubAccounts.starsFullSyncedAt}`,
          })
          .where(eq(githubAccounts.id, sync.id))
          .returning({ id: githubAccounts.id }),
      ).pipe(
        Effect.filterOrFail(Arr.isReadonlyArrayNonEmpty, () => new AccountNotFound({ accountId: sync.id })),
        Effect.asVoid,
      );
    },
  } satisfies Queries;
});

export const memory = Effect.gen(function* () {
  const { tables } = yield* Memory.MemoryStore;

  return {
    upsert: (facts) =>
      Effect.sync(() => {
        const existing = tables.accounts.get(facts.id);
        tables.accounts.set(facts.id, {
          claimedBy: null,
          starsEtag: null,
          starsSyncedAt: null,
          starsFullSyncedAt: null,
          ...existing,
          ...facts,
        });
      }),
    get: (id) => Effect.sync(() => Option.fromUndefinedOr(tables.accounts.get(id))),
    recordStarSync: (sync) =>
      Effect.suspend(() => {
        const account = tables.accounts.get(sync.id);
        if (account === undefined) return Effect.fail(new AccountNotFound({ accountId: sync.id }));
        tables.accounts.set(sync.id, {
          ...account,
          starsEtag: sync.etag,
          starsSyncedAt: sync.at,
          starsFullSyncedAt: sync.full ? sync.at : account.starsFullSyncedAt,
        });
        return Effect.void;
      }),
  } satisfies Queries;
});
