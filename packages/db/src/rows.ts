import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DbRowInvalid, type Operation } from "./errors.ts";

export const NullableTime = Schema.NullOr(Schema.DateTimeUtcFromDate);

export const rowsDecoder = <S extends Schema.Decoder<unknown>>(row: S) => {
  const decode = Schema.decodeUnknownEffect(Schema.Array(row));
  return (operation: Operation) => (rows: unknown) =>
    decode(rows).pipe(Effect.mapError(() => new DbRowInvalid({ operation })));
};
