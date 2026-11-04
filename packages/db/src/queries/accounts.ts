import { GitHubAccountId, Login } from "@stargrep/github/schemas";
import { eq } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { AccountNotFound, type DbQueryFailed, type DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { NullableTime, requireRow, rowsDecoder, writeEncoder } from "../rows.ts";
import { githubAccounts } from "../schema.ts";

export const Account = createSelectSchema(githubAccounts, {
  id: GitHubAccountId,
  login: Login,
  starsSyncedAt: NullableTime,
  starsFullSyncedAt: NullableTime,
});
export type Account = typeof Account.Type;

const AccountFacts = Schema.Struct(
  Struct.omit(Account.fields, ["claimedBy", "starsEtag", "starsSyncedAt", "starsFullSyncedAt"]),
);
export type AccountFacts = typeof AccountFacts.Type;

export interface StarSync {
  readonly accountId: GitHubAccountId;
  readonly etag: string | null;
  readonly at: DateTime.Utc;
}

export interface Queries {
  readonly upsert: (facts: AccountFacts) => Effect.Effect<void, DbQueryFailed>;
  readonly get: (id: GitHubAccountId) => Effect.Effect<Option.Option<Account>, DbQueryFailed | DbRowInvalid>;
  readonly recordStarSync: (sync: StarSync) => Effect.Effect<void, DbQueryFailed | AccountNotFound>;
}

const decodeAccounts = rowsDecoder(Account);
const encodeFacts = writeEncoder(AccountFacts);
const encodeTime = writeEncoder(Schema.DateTimeUtcFromDate);

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;

  return {
    upsert: (facts) =>
      encodeFacts(facts).pipe(
        Effect.flatMap((values) => {
          const { id: _, ...changes } = values;
          return run("accounts.upsert", (db) =>
            db.insert(githubAccounts).values(values).onConflictDoUpdate({ target: githubAccounts.id, set: changes }),
          );
        }),
      ),
    get: (id) =>
      run("accounts.get", (db) => db.select().from(githubAccounts).where(eq(githubAccounts.id, id))).pipe(
        Effect.flatMap(decodeAccounts("accounts.get")),
        Effect.map(Arr.head),
      ),
    recordStarSync: (sync) =>
      encodeTime(sync.at).pipe(
        Effect.flatMap((at) =>
          run("accounts.recordStarSync", (db) =>
            db
              .update(githubAccounts)
              .set({ starsEtag: sync.etag, starsSyncedAt: at })
              .where(eq(githubAccounts.id, sync.accountId))
              .returning({ id: githubAccounts.id }),
          ),
        ),
        Effect.flatMap(requireRow(() => new AccountNotFound({ accountId: sync.accountId }))),
      ),
  } satisfies Queries;
});
