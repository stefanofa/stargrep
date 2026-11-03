import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Summarize from "./prompts/summarize.ts";
import { toAiSchema } from "./schema-bridge.ts";

const summary: Summarize.RepoSummary = { summary: "A terminal UI library.", keywords: ["tui"], kind: "library" };

describe("toAiSchema", () => {
  const aiSchema = toAiSchema(Summarize.RepoSummary);

  it.effect("gives providers a draft-07 JSON schema with the kind enum", () =>
    Effect.sync(() => {
      expect(aiSchema.jsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(aiSchema.jsonSchema).toMatchObject({
        type: "object",
        required: ["summary", "keywords", "kind"],
        properties: { kind: { enum: [...Summarize.RepoKind.literals] } },
      });
    }),
  );

  it.effect("decodes with the Effect schema", () =>
    Effect.gen(function* () {
      expect(yield* aiSchema.decode(summary)).toEqual(summary);
      expect((yield* Effect.flip(aiSchema.decode({ ...summary, kind: "spaceship" })))._tag).toBe("SchemaError");
    }),
  );
});
