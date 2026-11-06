import { GitHubAccountId, Login } from "@stargrep/github/schemas";
import { eq, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { UserId } from "../auth-schema.ts";
import { AccountNotFound, type DbQueryFailed, type DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { NullableTime, requireRow, rowsDecoder, writeEncoder } from "../rows.ts";
import { githubAccounts } from "../schema.ts";

export const Account = createSelectSchema(githubAccounts, {
  id: GitHubAccountId,
  login: Login,
  claimedBy: Schema.NullOr(UserId),
  starsSyncedAt: NullableTime,
  starsFullSyncedAt: NullableTime,
});
export type Account = typeof Account.Type;

const AccountFacts = Schema.Struct(
  Struct.omit(Account.fields, [
    "claimedBy",
    "starredCount",
    "ownedRepoStars",
    "starsEtag",
    "starsSyncedAt",
    "starsFullSyncedAt",
  ]),
);
export type AccountFacts = typeof AccountFacts.Type;

export interface StarSync {
  readonly accountId: GitHubAccountId;
  readonly etag: string | null;
  readonly at: DateTime.Utc;
}

export interface AccountClaim {
  readonly facts: AccountFacts;
  readonly userId: UserId;
  readonly starredCount: number;
}

export interface StarredCount {
  readonly accountId: GitHubAccountId;
  readonly starredCount: number;
}

export interface OwnedRepoStars {
  readonly accountId: GitHubAccountId;
  readonly stars: number;
}

export interface Queries {
  // A starred count, when given, is written with the facts.
  readonly upsert: (facts: AccountFacts, starredCount?: number) => Effect.Effect<void, DbQueryFailed>;
  readonly claim: (claim: AccountClaim) => Effect.Effect<void, DbQueryFailed>;
  readonly claimedBy: (userId: UserId) => Effect.Effect<Option.Option<Account>, DbQueryFailed | DbRowInvalid>;
  readonly get: (id: GitHubAccountId) => Effect.Effect<Option.Option<Account>, DbQueryFailed | DbRowInvalid>;
  readonly byLogin: (login: Login) => Effect.Effect<Option.Option<Account>, DbQueryFailed | DbRowInvalid>;
  readonly require: (id: GitHubAccountId) => Effect.Effect<Account, DbQueryFailed | DbRowInvalid | AccountNotFound>;
  readonly setOwnedRepoStars: (input: OwnedRepoStars) => Effect.Effect<void, DbQueryFailed | AccountNotFound>;
  readonly setStarredCount: (input: StarredCount) => Effect.Effect<void, DbQueryFailed | AccountNotFound>;
  readonly recordStarSync: (sync: StarSync) => Effect.Effect<void, DbQueryFailed | AccountNotFound>;
}

const decodeAccounts = rowsDecoder(Account);
const encodeFacts = writeEncoder(AccountFacts);
const encodeTime = writeEncoder(Schema.DateTimeUtcFromDate);

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;

  return {
    upsert: (facts, starredCount) =>
      encodeFacts(facts).pipe(
        Effect.flatMap((values) => {
          const row = starredCount === undefined ? values : { ...values, starredCount };
          const { id: _, ...changes } = row;
          return run("accounts.upsert", (db) =>
            db.insert(githubAccounts).values(row).onConflictDoUpdate({ target: githubAccounts.id, set: changes }),
          );
        }),
      ),
    claim: ({ facts, userId, starredCount }) =>
      encodeFacts(facts).pipe(
        Effect.flatMap((values) => {
          const { id: _, ...changes } = values;
          const claimed = { claimedBy: userId, starredCount };
          return run("accounts.claim", (db) =>
            db
              .insert(githubAccounts)
              .values({ ...values, ...claimed })
              .onConflictDoUpdate({ target: githubAccounts.id, set: { ...changes, ...claimed } }),
          );
        }),
      ),
    claimedBy: (userId) =>
      run("accounts.claimedBy", (db) =>
        db.select().from(githubAccounts).where(eq(githubAccounts.claimedBy, userId)),
      ).pipe(Effect.flatMap(decodeAccounts("accounts.claimedBy")), Effect.map(Arr.head)),
    get: (id) =>
      run("accounts.get", (db) => db.select().from(githubAccounts).where(eq(githubAccounts.id, id))).pipe(
        Effect.flatMap(decodeAccounts("accounts.get")),
        Effect.map(Arr.head),
      ),
    byLogin: (login) =>
      run("accounts.byLogin", (db) =>
        db
          .select()
          .from(githubAccounts)
          .where(sql`lower(${githubAccounts.login}) = lower(${login})`)
          .orderBy(sql`${githubAccounts.starsSyncedAt} desc nulls last`, githubAccounts.id)
          .limit(1),
      ).pipe(Effect.flatMap(decodeAccounts("accounts.byLogin")), Effect.map(Arr.head)),
    require: (id) =>
      run("accounts.require", (db) => db.select().from(githubAccounts).where(eq(githubAccounts.id, id))).pipe(
        Effect.flatMap(decodeAccounts("accounts.require")),
        Effect.flatMap((rows) =>
          Effect.fromOption(Arr.head(rows)).pipe(Effect.mapError(() => new AccountNotFound({ accountId: id }))),
        ),
      ),
    setOwnedRepoStars: (input) =>
      run("accounts.setOwnedRepoStars", (db) =>
        db
          .update(githubAccounts)
          .set({ ownedRepoStars: input.stars })
          .where(eq(githubAccounts.id, input.accountId))
          .returning({ id: githubAccounts.id }),
      ).pipe(Effect.flatMap(requireRow(() => new AccountNotFound({ accountId: input.accountId })))),
    setStarredCount: (input) =>
      run("accounts.setStarredCount", (db) =>
        db
          .update(githubAccounts)
          .set({ starredCount: input.starredCount })
          .where(eq(githubAccounts.id, input.accountId))
          .returning({ id: githubAccounts.id }),
      ).pipe(Effect.flatMap(requireRow(() => new AccountNotFound({ accountId: input.accountId })))),
    recordStarSync: (sync) =>
      encodeTime(sync.at).pipe(
        Effect.flatMap((at) =>
          run("accounts.recordStarSync", (db) =>
            db
              .update(githubAccounts)
              .set({
                starsEtag: sql`case when ${githubAccounts.starsSyncedAt} > ${at}::timestamptz then ${githubAccounts.starsEtag} else ${sync.etag} end`,
                starsSyncedAt: sql`greatest(${githubAccounts.starsSyncedAt}, ${at}::timestamptz)`,
              })
              .where(eq(githubAccounts.id, sync.accountId))
              .returning({ id: githubAccounts.id }),
          ),
        ),
        Effect.flatMap(requireRow(() => new AccountNotFound({ accountId: sync.accountId }))),
      ),
  } satisfies Queries;
});
