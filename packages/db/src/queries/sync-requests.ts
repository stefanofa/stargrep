import type { Login } from "@stargrep/github/schemas";
import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
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
  readonly lifetime: Duration.Duration;
}

export interface Queries {
  readonly get: (login: Login) => Effect.Effect<Option.Option<SyncRequest>, DbQueryFailed | DbRowInvalid>;
  readonly claim: (claim: SyncClaim) => Effect.Effect<boolean, DbQueryFailed>;
  readonly markFailed: (login: Login, requestedAt: DateTime.Utc) => Effect.Effect<void, DbQueryFailed>;
}

const decodeRequests = rowsDecoder(SyncRequest);
const encodeTime = writeEncoder(Schema.DateTimeUtcFromDate);

const keyOf = (login: Login) => login.toLowerCase();

const before = (time: Date, duration: Duration.Duration) =>
  sql`${time}::timestamptz - ${`${Duration.toMillis(duration)} milliseconds`}::interval`;

const pruneBatch = 100;

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
    claim: Effect.fn("Db.syncRequests.claim")(function* ({ login, at, cooldown, lifetime }: SyncClaim) {
      const requestedAt = yield* encodeTime(at);
      yield* run("syncRequests.prune", (db) =>
        db.delete(syncRequests).where(
          inArray(
            syncRequests.login,
            db
              .select({ login: syncRequests.login })
              .from(syncRequests)
              .where(lt(syncRequests.requestedAt, before(requestedAt, lifetime)))
              .limit(pruneBatch)
              .for("update", { skipLocked: true }),
          ),
        ),
      );
      const claimed = yield* run("syncRequests.claim", (db) =>
        db
          .insert(syncRequests)
          .values({ login: keyOf(login), requestedAt, outcome: "pending" })
          .onConflictDoUpdate({
            target: syncRequests.login,
            set: { requestedAt, outcome: "pending" },
            setWhere: lte(syncRequests.requestedAt, before(requestedAt, cooldown)),
          })
          .returning({ login: syncRequests.login }),
      );
      return claimed.length > 0;
    }),
    markFailed: (login, requestedAt) =>
      encodeTime(requestedAt).pipe(
        Effect.flatMap((time) =>
          run("syncRequests.markFailed", (db) =>
            db
              .update(syncRequests)
              .set({ outcome: "failed" })
              .where(and(eq(syncRequests.login, keyOf(login)), eq(syncRequests.requestedAt, time))),
          ),
        ),
        Effect.asVoid,
      ),
  } satisfies Queries;
});
