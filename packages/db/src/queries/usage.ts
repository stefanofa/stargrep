import { and, eq, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { rowsDecoder } from "../rows.ts";
import { apiUsage } from "../schema.ts";

export const UsageCounts = Schema.Record(Schema.String, Schema.Int);
export type UsageCounts = typeof UsageCounts.Type;

const UsageRow = createSelectSchema(apiUsage, { counts: UsageCounts });

export interface UsageCall {
  readonly key: string;
  readonly procedure: string;
  readonly at: DateTime.Utc;
}

export interface UsageDay {
  readonly key: string;
  readonly on: DateTime.Utc;
}

export interface Queries {
  readonly increment: (call: UsageCall) => Effect.Effect<void, DbQueryFailed>;
  readonly get: (day: UsageDay) => Effect.Effect<UsageCounts, DbQueryFailed | DbRowInvalid>;
}

const decodeUsage = rowsDecoder(UsageRow);

export const make = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;

  return {
    increment: (call) =>
      run("usage.increment", (db) =>
        db
          .insert(apiUsage)
          .values({ key: call.key, day: DateTime.formatIsoDateUtc(call.at), counts: { [call.procedure]: 1 } })
          .onConflictDoUpdate({
            target: [apiUsage.key, apiUsage.day],
            set: {
              counts: sql`${apiUsage.counts} || jsonb_build_object(${call.procedure}::text, coalesce((${apiUsage.counts} ->> ${call.procedure}::text)::int, 0) + 1)`,
            },
          }),
      ),
    get: (day) =>
      run("usage.get", (db) =>
        db
          .select()
          .from(apiUsage)
          .where(and(eq(apiUsage.key, day.key), eq(apiUsage.day, DateTime.formatIsoDateUtc(day.on)))),
      ).pipe(
        Effect.flatMap(decodeUsage("usage.get")),
        Effect.map((rows) =>
          Arr.head(rows).pipe(Option.match({ onNone: (): UsageCounts => ({}), onSome: (row) => row.counts })),
        ),
      ),
  } satisfies Queries;
});
