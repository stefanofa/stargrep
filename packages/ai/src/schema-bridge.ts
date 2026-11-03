import type { JSONSchema7 } from "ai";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface AiSchema<A> {
  readonly jsonSchema: JSONSchema7;
  readonly decode: (output: unknown) => Effect.Effect<A, Schema.SchemaError>;
}

export const toAiSchema = <S extends Schema.ConstraintDecoder<unknown>>(schema: S): AiSchema<S["Type"]> => ({
  jsonSchema: Schema.toStandardJSONSchemaV1(schema)["~standard"].jsonSchema.input({ target: "draft-07" }),
  decode: Schema.decodeUnknownEffect(schema),
});
