import type { Login } from "@stargrep/github/schemas";
import { eq, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { rowsDecoder, writeEncoder } from "../rows.ts";
import { syncRequests } from "../schema.ts";

export const SyncRequest = createSelectSchema(syncRequests, { requestedAt: Schema.DateTimeUtcFromDate });
export type SyncRequest = typeof SyncRequest.Type;

export interface SyncClaim {
  readonly login: Login;
  readonly at: DateTime.Utc;
  readonly cooldown: Duration.Duration;
}

export interface Queries {
  readonly get: (login: Login) => Effect.Effect<Option.Option<SyncRequest>, DbQueryFailed | DbRowInvalid>;
  readonly claim: (claim: SyncClaim) => Effect.Effect<boolean, DbQueryFailed>;
  readonly markFailed: (login: Login, at: DateTime.Utc) => Effect.Effect<void, DbQueryFailed>;
}

const decodeRequests = rowsDecoder(SyncRequest);
const encodeTime = writeEncoder(Schema.DateTimeUtcFromDate);

const keyOf = (login: Login) => login.toLowerCase();

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;

  return {
    get: (login) =>
      run("syncRequests.get", (db) =>
        db
          .select()
          .from(syncRequests)
          .where(eq(syncRequests.login, keyOf(login))),
      ).pipe(Effect.flatMap(decodeRequests("syncRequests.get")), Effect.map(Arr.head)),
    claim: ({ login, at, cooldown }) =>
      encodeTime(at).pipe(
        Effect.flatMap((requestedAt) =>
          run("syncRequests.claim", (db) =>
            db
              .insert(syncRequests)
              .values({ login: keyOf(login), requestedAt, outcome: "pending" })
              .onConflictDoUpdate({
                target: syncRequests.login,
                set: { requestedAt, outcome: "pending" },
                setWhere: sql`${syncRequests.requestedAt} <= ${requestedAt}::timestamptz - ${`${Duration.toMillis(cooldown)} milliseconds`}::interval`,
              })
              .returning({ login: syncRequests.login }),
          ),
        ),
        Effect.map((claimed) => claimed.length > 0),
      ),
    markFailed: (login, at) =>
      encodeTime(at).pipe(
        Effect.flatMap((requestedAt) =>
          run("syncRequests.markFailed", (db) =>
            db
              .insert(syncRequests)
              .values({ login: keyOf(login), requestedAt, outcome: "failed" })
              .onConflictDoUpdate({ target: syncRequests.login, set: { outcome: "failed" } }),
          ),
        ),
        Effect.asVoid,
      ),
  } satisfies Queries;
});
