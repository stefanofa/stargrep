import { sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { rowsDecoder, timeParam } from "../rows.ts";
import { syncLine } from "../schema.ts";

// The generic cell rate algorithm with weighted cells. busy_until is when the line would be clear of every reserved
// cost. A reservation starts once busy_until minus the tolerance has passed, so up to the tolerance starts at once.
export interface Reservation {
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
    at: DateTime.Utc,
    tolerance: Duration.Duration,
  ) => Effect.Effect<Duration.Duration, DbQueryFailed | DbRowInvalid>;
  // When the reservation starts, or none when it would wait past maxWait. A refusal changes nothing.
  readonly reserve: (
    reservation: Reservation,
  ) => Effect.Effect<Option.Option<DateTime.Utc>, DbQueryFailed | DbRowInvalid>;
}

const decodeBusy = rowsDecoder(Schema.Struct({ busyUntil: Schema.DateTimeUtcFromDate }));
const decodeStarts = rowsDecoder(Schema.Struct({ startsAt: Schema.DateTimeUtcFromDate }));

const interval = (duration: Duration.Duration) => sql`${`${Duration.toMillis(duration)} milliseconds`}::interval`;

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;

  return {
    wait: (at, tolerance) =>
      run("syncLine.wait", (db) => db.select({ busyUntil: syncLine.busyUntil }).from(syncLine)).pipe(
        Effect.flatMap(decodeBusy("syncLine.wait")),
        Effect.map((rows) =>
          Option.match(Arr.head(rows), {
            onNone: () => Duration.zero,
            onSome: ({ busyUntil }) => {
              const startsAt = DateTime.subtractDuration(busyUntil, tolerance);
              return DateTime.isGreaterThan(startsAt, at) ? DateTime.distance(at, startsAt) : Duration.zero;
            },
          }),
        ),
      ),
    // The row lock of the upsert serializes reservations, so two never get the same start. returning reads the new
    // busy_until, and the new value less the cost is greatest(old, at), so the start comes out as greatest(at, old less
    // the tolerance).
    reserve: ({ at, cost, tolerance, maxWait, force }) => {
      const now = timeParam(at);
      return run("syncLine.reserve", (db) =>
        db
          .insert(syncLine)
          .values({ singleton: true, busyUntil: sql`${now} + ${interval(cost)}` })
          .onConflictDoUpdate({
            target: syncLine.singleton,
            set: { busyUntil: sql`greatest(${syncLine.busyUntil}, ${now}) + ${interval(cost)}` },
            ...(force
              ? {}
              : {
                  setWhere: sql`greatest(${now}, ${syncLine.busyUntil} - ${interval(tolerance)}) <= ${now} + ${interval(maxWait)}`,
                }),
          })
          .returning({
            startsAt: sql`greatest(${now}, ${syncLine.busyUntil} - ${interval(cost)} - ${interval(tolerance)})`.mapWith(
              syncLine.busyUntil,
            ),
          }),
      ).pipe(
        Effect.flatMap(decodeStarts("syncLine.reserve")),
        Effect.map((rows) => Option.map(Arr.head(rows), (row) => row.startsAt)),
      );
    },
  } satisfies Queries;
});
