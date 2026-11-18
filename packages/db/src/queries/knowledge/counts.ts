import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DbQueryFailed, DbRowInvalid } from "../../errors.ts";
import * as Postgres from "../../postgres.ts";
import { only, rowsDecoder, statements } from "../../rows.ts";

export interface Queries {
  // The nightly count behind listing. Returns how many subjects changed.
  readonly count: Effect.Effect<number, DbQueryFailed | DbRowInvalid>;
  // The nightly count of each closed value's bare key, which lookups read. Returns how many rows changed.
  readonly countAtoms: Effect.Effect<number, DbQueryFailed | DbRowInvalid>;
}

const decodeCount = rowsDecoder(Schema.Struct({ count: Schema.Int }));

export const make = Effect.gen(function* () {
  const { run, withLongTimeout } = yield* Postgres.Postgres;
  const { query } = statements(run);

  // Each count reads every live repo's atoms, so it runs under the long limit. No request waits on it.
  return {
    count: withLongTimeout(query("knowledge.count", decodeCount, sql`select knowledge_refresh_counts() as count`)).pipe(
      Effect.flatMap(only),
      Effect.map((row) => row.count),
    ),
    countAtoms: withLongTimeout(
      query("knowledge.countAtoms", decodeCount, sql`select knowledge_refresh_atom_stats() as count`),
    ).pipe(
      Effect.flatMap(only),
      Effect.map((row) => row.count),
    ),
  } satisfies Queries;
});
