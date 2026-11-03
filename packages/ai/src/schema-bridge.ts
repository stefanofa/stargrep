import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "effect/StandardSchema";

export type AiSchema<A> = StandardSchemaV1<unknown, A> & StandardJSONSchemaV1<unknown, A>;

export const toAiSchema = <S extends Schema.ConstraintDecoder<unknown>>(schema: S): AiSchema<S["Type"]> =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));

export const jsonSchema = <A>(schema: AiSchema<A>) => schema["~standard"].jsonSchema.input({ target: "draft-07" });

export const validate = <A>(schema: AiSchema<A>, value: unknown): Effect.Effect<Option.Option<A>> =>
  Effect.promise(async () => schema["~standard"].validate(value)).pipe(
    Effect.map((result) => (result.issues === undefined ? Option.some(result.value) : Option.none())),
  );
