import type { Owner } from "@stargrep/github/owner";
import { GitHubAccountId, Login } from "@stargrep/github/schemas";
import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import type { PgSelect } from "drizzle-orm/pg-core";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { UserId } from "../auth-schema.ts";
import { AccountNotFound, type DbQueryFailed, type DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { NullableTime, requireRow, rowsDecoder, timeParam, writeEncoder } from "../rows.ts";
import { follows, githubAccounts, people } from "../schema.ts";

// stars_etag stays in the table until a cleanup migration drops it. Nothing reads or writes it.
export const Account = Schema.Struct(
  Struct.omit(
    createSelectSchema(githubAccounts, {
      id: GitHubAccountId,
      login: Login,
      claimedBy: Schema.NullOr(UserId),
      starsSyncedAt: NullableTime,
      starsFullSyncedAt: NullableTime,
      starsCheckedAt: NullableTime,
    }).fields,
    ["starsEtag"],
  ),
);
export type Account = typeof Account.Type;

const AccountFacts = Schema.Struct(
  Struct.omit(Account.fields, [
    "claimedBy",
    "starredCount",
    "ownedRepoStars",
    "starsSyncedAt",
    "starsFullSyncedAt",
    "starsCheckedAt",
  ]),
);
export type AccountFacts = typeof AccountFacts.Type;

export interface StarSync {
  readonly accountId: GitHubAccountId;
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

// A synced user the star probe asks GitHub about.
export const StarCheckDue = Schema.Struct({
  id: GitHubAccountId,
  login: Login,
  starredCount: Schema.NullOr(Schema.Int),
  starsSyncedAt: Schema.DateTimeUtcFromDate,
});
export type StarCheckDue = typeof StarCheckDue.Type;

export interface OwnedRepoStars {
  readonly accountId: GitHubAccountId;
  readonly stars: number;
}

export interface Queries {
  readonly upsert: (facts: AccountFacts) => Effect.Effect<void, DbQueryFailed>;
  // Writes what a lookup of the login found: its facts and how many repos it starred.
  readonly upsertLooked: (owner: Owner) => Effect.Effect<void, DbQueryFailed>;
  readonly claim: (claim: AccountClaim) => Effect.Effect<void, DbQueryFailed>;
  readonly claimedBy: (userId: UserId) => Effect.Effect<Option.Option<Account>, DbQueryFailed | DbRowInvalid>;
  readonly get: (id: GitHubAccountId) => Effect.Effect<Option.Option<Account>, DbQueryFailed | DbRowInvalid>;
  readonly byLogin: (login: Login) => Effect.Effect<Option.Option<Account>, DbQueryFailed | DbRowInvalid>;
  readonly require: (id: GitHubAccountId) => Effect.Effect<Account, DbQueryFailed | DbRowInvalid | AccountNotFound>;
  readonly setOwnedRepoStars: (input: OwnedRepoStars) => Effect.Effect<void, DbQueryFailed | AccountNotFound>;
  readonly setStarredCount: (input: StarredCount) => Effect.Effect<void, DbQueryFailed | AccountNotFound>;
  readonly recordStarSync: (sync: StarSync) => Effect.Effect<void, DbQueryFailed | AccountNotFound>;
  // Synced users whose stars were never checked, or last checked before their cutoff, the oldest check first. A person
  // on the people list, or followed by anyone, has a cutoff of their own.
  readonly dueForStarCheck: (input: {
    readonly peopleBefore: DateTime.Utc;
    readonly othersBefore: DateTime.Utc;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<StarCheckDue>, DbQueryFailed | DbRowInvalid>;
  // Records a check of each account at `at`, with the starred total GitHub reported. A check never moves back.
  readonly recordStarChecks: (input: {
    readonly checks: ReadonlyArray<StarredCount>;
    readonly at: DateTime.Utc;
  }) => Effect.Effect<void, DbQueryFailed>;
}

// GitHub can give a login to a new account while an account renamed away from it keeps it here, so a login names the
// account that synced most recently, then the one with the lowest ID. github_accounts_login_idx serves the lookup.
export const accountNamed = <T extends PgSelect>(query: T, login: Login) =>
  query
    .where(sql`lower(${githubAccounts.login}) = lower(${login})`)
    .orderBy(sql`${githubAccounts.starsSyncedAt} desc nulls last`, githubAccounts.id)
    .limit(1);

const decodeAccounts = rowsDecoder(Account);
const decodeDue = rowsDecoder(StarCheckDue);
const encodeFacts = writeEncoder(AccountFacts);
const encodeTime = writeEncoder(Schema.DateTimeUtcFromDate);

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;

  const upsert = (operation: "accounts.upsert" | "accounts.upsertLooked", facts: AccountFacts, starredCount?: number) =>
    encodeFacts(facts).pipe(
      Effect.flatMap((values) => {
        const row = starredCount === undefined ? values : { ...values, starredCount };
        const { id: _, ...changes } = row;
        return run(operation, (db) =>
          db.insert(githubAccounts).values(row).onConflictDoUpdate({ target: githubAccounts.id, set: changes }),
        );
      }),
    );

  return {
    upsert: (facts) => upsert("accounts.upsert", facts),
    upsertLooked: (owner) => upsert("accounts.upsertLooked", owner.account, owner.starredTotal),
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
      run("accounts.byLogin", (db) => accountNamed(db.select().from(githubAccounts).$dynamic(), login)).pipe(
        Effect.flatMap(decodeAccounts("accounts.byLogin")),
        Effect.map(Arr.head),
      ),
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
              .set({ starsSyncedAt: sql`greatest(${githubAccounts.starsSyncedAt}, ${at}::timestamptz)` })
              .where(eq(githubAccounts.id, sync.accountId))
              .returning({ id: githubAccounts.id }),
          ),
        ),
        Effect.flatMap(requireRow(() => new AccountNotFound({ accountId: sync.accountId }))),
      ),
    dueForStarCheck: ({ peopleBefore, othersBefore, limit }) =>
      run("accounts.dueForStarCheck", (db) =>
        db
          .select({
            id: githubAccounts.id,
            login: githubAccounts.login,
            starredCount: githubAccounts.starredCount,
            starsSyncedAt: githubAccounts.starsSyncedAt,
          })
          .from(githubAccounts)
          .where(
            and(
              eq(githubAccounts.type, "user"),
              isNotNull(githubAccounts.starsSyncedAt),
              or(
                isNull(githubAccounts.starsCheckedAt),
                lt(
                  githubAccounts.starsCheckedAt,
                  sql`case when exists (select 1 from ${people} where ${people.accountId} = ${githubAccounts.id})
                    or exists (select 1 from ${follows} where ${follows.followeeId} = ${githubAccounts.id})
                    then ${timeParam(peopleBefore)} else ${timeParam(othersBefore)} end`,
                ),
              ),
            ),
          )
          .orderBy(sql`${githubAccounts.starsCheckedAt} asc nulls first`, asc(githubAccounts.id))
          .limit(limit),
      ).pipe(Effect.flatMap(decodeDue("accounts.dueForStarCheck"))),
    recordStarChecks: ({ checks, at }) =>
      checks.length === 0
        ? Effect.void
        : run("accounts.recordStarChecks", (db) =>
            db.execute(sql`
              update ${githubAccounts} set
                stars_checked_at = greatest(${githubAccounts.starsCheckedAt}, ${timeParam(at)}),
                starred_count = checked.starred_count
              from unnest(
                ${sql.param(checks.map((check) => check.accountId))}::bigint[],
                ${sql.param(checks.map((check) => check.starredCount))}::int[]
              ) as checked (id, starred_count)
              where ${githubAccounts.id} = checked.id`),
          ).pipe(Effect.asVoid),
  } satisfies Queries;
});
