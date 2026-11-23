import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { toAiSchema } from "./schema-bridge.ts";

const Answer = Schema.Struct({ summary: Schema.String, kind: Schema.Literals(["library", "cli"]) });
describe("toAiSchema", () => {
  const aiSchema = toAiSchema(Answer);

  it.effect("gives providers a draft-07 JSON schema with the literal enum", () =>
    Effect.sync(() => {
      expect(aiSchema.jsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(aiSchema.jsonSchema).toMatchObject({
        type: "object",
        required: ["summary", "kind"],
        properties: { kind: { enum: ["library", "cli"] } },
      });
    }),
  );
});
