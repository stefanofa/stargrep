import { Revision, type SubjectId } from "@stargrep/knowledge/ids";
import type { LabelKey } from "@stargrep/knowledge/label-key";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Operation } from "../../errors.ts";
import { only, type Query, rowsDecoder } from "../../rows.ts";

// Nothing writes a private namespace yet, so every vocabulary write here is public.
export const namespace = "public";

// One advisory lock per namespace guards the vocabulary. Mints and decisions take it exclusively, and projections take
// it shared, so a vocabulary change waits for every projection in flight and then marks the rows they wrote.
const lockKey = sql`hashtextextended(${`stargrep:knowledge:${namespace}`}, 0)`;
export const exclusiveLock = sql`select pg_advisory_xact_lock(${lockKey})`;
export const sharedLock = sql`select pg_advisory_xact_lock_shared(${lockKey})`;

export interface Invalidation {
  readonly keys: ReadonlyArray<LabelKey>;
  readonly subjects: ReadonlyArray<SubjectId>;
}

const decodeRevision = rowsDecoder(Schema.Struct({ revision: Revision }));
const decodeCount = rowsDecoder(Schema.Struct({ count: Schema.Int }));

export const vocabulary = (query: Query) => ({
  head: query(
    "knowledge.revision",
    decodeRevision,
    sql`select coalesce(max(revision), 0)::integer as revision from decisions where namespace = ${namespace}`,
  ).pipe(
    Effect.flatMap(only),
    Effect.map((row) => row.revision),
  ),
  invalidated: (operation: Operation, invalidation: Invalidation) =>
    query(
      operation,
      decodeCount,
      sql`select knowledge_invalidate(${sql.param([...invalidation.keys])}::text[], ${sql.param([...invalidation.subjects])}::bigint[]) as count`,
    ).pipe(
      Effect.flatMap(only),
      Effect.map((row) => row.count),
    ),
});
