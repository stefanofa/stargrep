import { eq, lt, type SQL, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { rowsDecoder, timeParam } from "../rows.ts";
import { rateLines } from "../schema.ts";

// A keyed hash of the network a request came from, never the address.
export const CallerKey = Schema.String.pipe(Schema.brand("CallerKey"));
export type CallerKey = typeof CallerKey.Type;

// Names a rate line. Core names every line it meters, so this package holds none of their names.
export const LineKey = Schema.String.pipe(Schema.brand("LineKey"));
export type LineKey = typeof LineKey.Type;

// The generic cell rate algorithm with weighted cells. busy_until is when the line would be clear of every reserved
// cost. A reservation starts once busy_until minus the tolerance has passed, so up to the tolerance starts at once.
export interface Reservation {
  readonly line: LineKey;
  readonly at: DateTime.Utc;
  readonly cost: Duration.Duration;
  readonly tolerance: Duration.Duration;
  readonly maxWait: Duration.Duration;
  // Reserves even past maxWait, for work that pays into the line but never waits.
  readonly force: boolean;
}

export interface Queries {
  // How long a reservation made at this time would wait. Zero when the line is clear.
  readonly wait: (
    line: LineKey,
    at: DateTime.Utc,
    tolerance: Duration.Duration,
  ) => Effect.Effect<Duration.Duration, DbQueryFailed | DbRowInvalid>;
  // When the reservation starts, or none when it would wait past maxWait. A refusal changes nothing.
  readonly reserve: (
    reservation: Reservation,
  ) => Effect.Effect<Option.Option<DateTime.Utc>, DbQueryFailed | DbRowInvalid>;
  // Moves the line later by a positive amount, as a forced reservation does, or earlier by a negative one, never past at.
  readonly adjust: (line: LineKey, at: DateTime.Utc, by: Duration.Duration) => Effect.Effect<void, DbQueryFailed>;
  // Deletes every line the clock has passed. Such a line reserves the same as no row.
  readonly prune: (at: DateTime.Utc) => Effect.Effect<void, DbQueryFailed>;
}

const decodeStarts = rowsDecoder(Schema.Struct({ startsAt: Schema.DateTimeUtcFromDate }));

const interval = (duration: Duration.Duration) => sql`${`${Duration.toMillis(duration)} milliseconds`}::interval`;

// When a reservation made at now starts on a line busy until busy.
const startOf = (now: SQL, busy: SQL, tolerance: Duration.Duration) =>
  sql`greatest(${now}, ${busy} - ${interval(tolerance)})`;

const busyUntil = sql`${rateLines.busyUntil}`;

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;

  return {
    wait: (line, at, tolerance) =>
      run("rateLines.wait", (db) =>
        db
          .select({ startsAt: startOf(timeParam(at), busyUntil, tolerance).mapWith(rateLines.busyUntil) })
          .from(rateLines)
          .where(eq(rateLines.key, line)),
      ).pipe(
        Effect.flatMap(decodeStarts("rateLines.wait")),
        Effect.map((rows) =>
          Option.match(Arr.head(rows), {
            onNone: () => Duration.zero,
            onSome: ({ startsAt }) => DateTime.distance(at, startsAt),
          }),
        ),
      ),
    // The row lock of the upsert serializes reservations, so two never get the same start. returning reads the new
    // busy_until, and the new value less the cost is greatest(old, at), so it yields the start the old value gave.
    reserve: ({ line, at, cost, tolerance, maxWait, force }) => {
      const now = timeParam(at);
      return run("rateLines.reserve", (db) =>
        db
          .insert(rateLines)
          .values({ key: line, busyUntil: sql`${now} + ${interval(cost)}` })
          .onConflictDoUpdate({
            target: rateLines.key,
            set: { busyUntil: sql`greatest(${busyUntil}, ${now}) + ${interval(cost)}` },
            ...(force ? {} : { setWhere: sql`${startOf(now, busyUntil, tolerance)} <= ${now} + ${interval(maxWait)}` }),
          })
          .returning({
            startsAt: startOf(now, sql`${busyUntil} - ${interval(cost)}`, tolerance).mapWith(rateLines.busyUntil),
          }),
      ).pipe(
        Effect.flatMap(decodeStarts("rateLines.reserve")),
        Effect.map((rows) => Option.map(Arr.head(rows), (row) => row.startsAt)),
      );
    },
    adjust: (line, at, by) => {
      const now = timeParam(at);
      return run("rateLines.adjust", (db) =>
        db
          .insert(rateLines)
          .values({ key: line, busyUntil: sql`${now} + greatest(${interval(by)}, '0'::interval)` })
          .onConflictDoUpdate({
            target: rateLines.key,
            set: { busyUntil: sql`greatest(greatest(${busyUntil}, ${now}) + ${interval(by)}, ${now})` },
          }),
      ).pipe(Effect.asVoid);
    },
    prune: (at) =>
      run("rateLines.prune", (db) => db.delete(rateLines).where(lt(rateLines.busyUntil, timeParam(at)))).pipe(
        Effect.asVoid,
      ),
  } satisfies Queries;
});
