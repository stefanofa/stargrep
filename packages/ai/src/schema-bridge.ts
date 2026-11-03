import * as Schema from "effect/Schema";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "effect/StandardSchema";

export type AiSchema<A> = StandardSchemaV1<unknown, A> & StandardJSONSchemaV1<unknown, A>;

export const toAiSchema = <S extends Schema.ConstraintDecoder<unknown>>(schema: S): AiSchema<S["Type"]> =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));
