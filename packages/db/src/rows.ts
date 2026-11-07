import { type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { DbRowInvalid, type Operation } from "./errors.ts";

export const NullableTime = Schema.NullOr(Schema.DateTimeUtcFromDate);

export const timeParam = (value: DateTime.Utc): SQL => sql`${DateTime.formatIso(value)}::timestamptz`;

export const excluded = (column: PgColumn): SQL => sql`excluded.${sql.identifier(column.name)}`;

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

const columnOf = (issue: SchemaIssue.Issue): string | null =>
  formatIssue(issue).issues[0]?.path?.findLast(Predicate.isString) ?? null;

export const rowsDecoder = <S extends Schema.Decoder<unknown>>(row: S) => {
  const decode = Schema.decodeUnknownEffect(Schema.Array(row));
  return (operation: Operation) => (rows: unknown) =>
    decode(rows).pipe(Effect.mapError((error) => new DbRowInvalid({ operation, column: columnOf(error.issue) })));
};

export const writeEncoder = <S extends Schema.Encoder<unknown>>(schema: S) => {
  const encode = Schema.encodeEffect(schema);
  return (value: S["Type"]) => encode(value).pipe(Effect.orDie);
};

// db.execute returns the driver's raw result, which holds the rows.
export const resultRows = (result: unknown): unknown => (Predicate.hasProperty(result, "rows") ? result.rows : result);

export const requireRow =
  <E>(notFound: () => E) =>
  (rows: ReadonlyArray<unknown>): Effect.Effect<void, E> =>
    rows.length === 0 ? Effect.fail(notFound()) : Effect.void;
