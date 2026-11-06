import type { Login } from "@stargrep/github/schemas";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { NullableTime, rowsDecoder, timeParam, writeEncoder } from "../rows.ts";
import { syncRequests } from "../schema.ts";

export const SyncRequest = createSelectSchema(syncRequests, {
  requestedAt: Schema.DateTimeUtcFromDate,
  startsAt: NullableTime,
});
export type SyncRequest = typeof SyncRequest.Type;

export interface SyncClaim {
  readonly login: Login;
  readonly at: DateTime.Utc;
  // Counted from when the held request starts, so a request waiting in line keeps its login until it has run.
  readonly cooldown: Duration.Duration;
  // Also wins over a request still waiting in line, for a requester who never waits.
  readonly overtakesWaiting: boolean;
  // claimed holds the login while its sync is reserved and sent. missing records a login GitHub does not have.
  readonly outcome: "claimed" | "missing";
}

export type Settlement = "failed" | "released";

export interface Queries {
  readonly get: (login: Login) => Effect.Effect<Option.Option<SyncRequest>, DbQueryFailed | DbRowInvalid>;
  readonly claim: (claim: SyncClaim) => Effect.Effect<boolean, DbQueryFailed>;
  // How many pending requests still wait in line at the given time and start before startsAt.
  readonly ahead: (startsAt: DateTime.Utc, at: DateTime.Utc) => Effect.Effect<number, DbQueryFailed>;
  // Each of these touches the row only while it still holds the request made at requestedAt. schedule records a sent
  // sync and when it starts.
  readonly schedule: (
    login: Login,
    requestedAt: DateTime.Utc,
    startsAt: DateTime.Utc,
  ) => Effect.Effect<void, DbQueryFailed>;
  // released deletes the row, so the next request claims at once.
  readonly settle: (login: Login, requestedAt: DateTime.Utc, outcome: Settlement) => Effect.Effect<void, DbQueryFailed>;
  // Deletes every request made before the given time.
  readonly prune: (before: DateTime.Utc) => Effect.Effect<void, DbQueryFailed>;
}

const decodeRequests = rowsDecoder(SyncRequest);
const encodeTime = writeEncoder(Schema.DateTimeUtcFromDate);

const keyOf = (login: Login) => login.toLowerCase();

const before = (time: Date, duration: Duration.Duration) =>
  sql`${time}::timestamptz - ${`${Duration.toMillis(duration)} milliseconds`}::interval`;

const cooledDown = (time: Date, cooldown: Duration.Duration) =>
  sql`coalesce(${syncRequests.startsAt}, ${syncRequests.requestedAt}) <= ${before(time, cooldown)}`;

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;

  const holding = (login: Login, requestedAt: Date) =>
    and(eq(syncRequests.login, keyOf(login)), eq(syncRequests.requestedAt, requestedAt));

  return {
    get: (login) =>
      run("syncRequests.get", (db) =>
        db
          .select()
          .from(syncRequests)
          .where(eq(syncRequests.login, keyOf(login))),
      ).pipe(Effect.flatMap(decodeRequests("syncRequests.get")), Effect.map(Arr.head)),
    claim: Effect.fn("Db.syncRequests.claim")(function* ({
      login,
      at,
      cooldown,
      overtakesWaiting,
      outcome,
    }: SyncClaim) {
      const requestedAt = yield* encodeTime(at);
      const claimed = yield* run("syncRequests.claim", (db) =>
        db
          .insert(syncRequests)
          .values({ login: keyOf(login), requestedAt, outcome })
          .onConflictDoUpdate({
            target: syncRequests.login,
            set: { requestedAt, outcome, startsAt: null },
            setWhere: overtakesWaiting
              ? sql`${cooledDown(requestedAt, cooldown)} or ${syncRequests.startsAt} > ${requestedAt}::timestamptz`
              : cooledDown(requestedAt, cooldown),
          })
          .returning({ login: syncRequests.login }),
      );
      return claimed.length > 0;
    }),
    ahead: (startsAt, at) =>
      run("syncRequests.ahead", (db) =>
        db
          .select({ ahead: sql<number>`count(*)::int` })
          .from(syncRequests)
          .where(
            and(
              eq(syncRequests.outcome, "pending"),
              gt(syncRequests.startsAt, sql`${timeParam(at)}`),
              lt(syncRequests.startsAt, sql`${timeParam(startsAt)}`),
            ),
          ),
      ).pipe(Effect.map((rows) => rows[0]?.ahead ?? 0)),
    schedule: (login, requestedAt, startsAt) =>
      Effect.all([encodeTime(requestedAt), encodeTime(startsAt)]).pipe(
        Effect.flatMap(([time, start]) =>
          run("syncRequests.schedule", (db) =>
            db.update(syncRequests).set({ outcome: "pending", startsAt: start }).where(holding(login, time)),
          ),
        ),
        Effect.asVoid,
      ),
    settle: (login, requestedAt, outcome) =>
      encodeTime(requestedAt).pipe(
        Effect.flatMap((time) =>
          run("syncRequests.settle", (db) =>
            outcome === "released"
              ? db.delete(syncRequests).where(holding(login, time))
              : db.update(syncRequests).set({ outcome }).where(holding(login, time)),
          ),
        ),
        Effect.asVoid,
      ),
    prune: (time) =>
      encodeTime(time).pipe(
        Effect.flatMap((cutoff) =>
          run("syncRequests.prune", (db) => db.delete(syncRequests).where(lt(syncRequests.requestedAt, cutoff))),
        ),
        Effect.asVoid,
      ),
  } satisfies Queries;
});
