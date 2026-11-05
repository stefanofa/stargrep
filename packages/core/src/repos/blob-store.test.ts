import { describe, expect, test } from "bun:test";
import { ObjectId } from "@stargrep/github/schemas";
import * as Schema from "effect/Schema";
import { readmeKey } from "./blob-store.ts";

describe("readmeKey", () => {
  test("names a README blob by its object id", () => {
    expect(readmeKey(Schema.decodeSync(ObjectId)("f".repeat(40)))).toBe(`readmes/${"f".repeat(40)}`);
  });
});
