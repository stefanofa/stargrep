import { eq, inArray, lt, sql } from "drizzle-orm";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { rowsDecoder, timeParam } from "../rows.ts";
import { syncLines } from "../schema.ts";

// A keyed hash of the network a request came from, never the address.
export const CallerKey = Schema.String.pipe(Schema.brand("CallerKey"));
export type CallerKey = typeof CallerKey.Type;

// Every signed-out sync takes a turn in the line all. A login that never synced also takes one in its caller's line.
// Planner and query embedding calls take one in model/all and one in their caller's model line.
export type LineKey = "all" | `caller/${CallerKey}` | "model/all" | `model/${CallerKey}`;

export const callerLine = (caller: CallerKey): LineKey => `caller/${caller}`;

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
}

const decodeBusy = rowsDecoder(Schema.Struct({ busyUntil: Schema.DateTimeUtcFromDate }));
const decodeStarts = rowsDecoder(Schema.Struct({ startsAt: Schema.DateTimeUtcFromDate }));

const interval = (duration: Duration.Duration) => sql`${`${Duration.toMillis(duration)} milliseconds`}::interval`;

const pruneBatch = 100;

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;

  return {
    wait: (line, at, tolerance) =>
      run("syncLine.wait", (db) =>
        db.select({ busyUntil: syncLines.busyUntil }).from(syncLines).where(eq(syncLines.key, line)),
      ).pipe(
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
    // the tolerance). A clear line reserves as if it had no row, so the prune can delete it.
    reserve: Effect.fn("Db.syncLine.reserve")(function* ({ line, at, cost, tolerance, maxWait, force }: Reservation) {
      const now = timeParam(at);
      yield* run("syncLine.prune", (db) =>
        db
          .delete(syncLines)
          .where(
            inArray(
              syncLines.key,
              db
                .select({ key: syncLines.key })
                .from(syncLines)
                .where(lt(syncLines.busyUntil, now))
                .limit(pruneBatch)
                .for("update", { skipLocked: true }),
            ),
          ),
      );
      const rows = yield* run("syncLine.reserve", (db) =>
        db
          .insert(syncLines)
          .values({ key: line, busyUntil: sql`${now} + ${interval(cost)}` })
          .onConflictDoUpdate({
            target: syncLines.key,
            set: { busyUntil: sql`greatest(${syncLines.busyUntil}, ${now}) + ${interval(cost)}` },
            ...(force
              ? {}
              : {
                  setWhere: sql`greatest(${now}, ${syncLines.busyUntil} - ${interval(tolerance)}) <= ${now} + ${interval(maxWait)}`,
                }),
          })
          .returning({
            startsAt:
              sql`greatest(${now}, ${syncLines.busyUntil} - ${interval(cost)} - ${interval(tolerance)})`.mapWith(
                syncLines.busyUntil,
              ),
          }),
      ).pipe(Effect.flatMap(decodeStarts("syncLine.reserve")));
      return Option.map(Arr.head(rows), (row) => row.startsAt);
    }),
  } satisfies Queries;
});
