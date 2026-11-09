import { describe, expect, test } from "bun:test";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import { inputHash, type LegacyAnswer, legacyHash, type PromptFacts } from "./input-hash.ts";

const ratatui: PromptFacts = {
  readmeOid: "0123456789abcdef0123456789abcdef01234567",
  fullName: "ratatui/ratatui",
  description: "A Rust crate for cooking up terminal user interfaces",
  topics: ["tui", "rust"],
  language: "Rust",
};

const hash = (facts: PromptFacts): Promise<string> =>
  Effect.runPromise(inputHash(facts).pipe(Effect.provide(Digest.layerWebCrypto)));

describe("inputHash", () => {
  // Pinned with `printf '%s' '<the JSON array>' | shasum -a 256`, so a change to the encoding fails here first.
  test("is the SHA-256 of the version and the facts as one JSON array", async () => {
    expect(await hash(ratatui)).toBe("30793879b483eb9a4f8d02522133eee2b9d01862e7ebf8daa5fccb9c166c4fe7");
    expect(
      await hash({ readmeOid: null, fullName: "probe/empty", description: null, topics: [], language: null }),
    ).toBe("dedfa721ce57ad51bb8cf9861e38d71be3b4d0b7014b6c7c53f498b3e532277b");
  });

  test("moves with every fact the prompt reads", async () => {
    const changed: ReadonlyArray<PromptFacts> = [
      { ...ratatui, readmeOid: "f".repeat(40) },
      { ...ratatui, readmeOid: null },
      { ...ratatui, fullName: "ratatui/ratatui-core" },
      { ...ratatui, description: null },
      { ...ratatui, description: "none" },
      { ...ratatui, topics: ["rust", "tui"] },
      { ...ratatui, topics: ["tui, rust"] },
      { ...ratatui, topics: [] },
      { ...ratatui, language: null },
      { ...ratatui, language: "unknown" },
    ];
    const hashes = await Promise.all([ratatui, ...changed].map(hash));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test("is the same for the same facts", async () => {
    expect(await hash({ ...ratatui, topics: [...ratatui.topics] })).toBe(await hash(ratatui));
  });
});

describe("legacyHash", () => {
  const answer: LegacyAnswer = {
    summary: "Ratatui is a Rust library for terminal user interfaces.",
    keywords: ["tui", "terminal"],
    kind: "library",
  };
  const legacy = (facts: PromptFacts, given: LegacyAnswer): Promise<string> =>
    Effect.runPromise(legacyHash(facts, given).pipe(Effect.provide(Digest.layerWebCrypto)));

  // printf '%s' '["<inputHash of ratatui>","<summary>",["tui","terminal"],"library"]' | shasum -a 256
  test("is the SHA-256 of the input hash and the answer as one JSON array", async () => {
    expect(await legacy(ratatui, answer)).toBe("9a8c83dc100dfa5d9e87b9423dcd15dbb166c5f88d9531972a78c680773d16e3");
  });

  test("moves with the answer as well as the input, so a second summary of one README gets its own key", async () => {
    const hashes = await Promise.all([
      legacy(ratatui, answer),
      legacy(ratatui, { ...answer, summary: "A second summary of the same README." }),
      legacy(ratatui, { ...answer, keywords: ["tui"] }),
      legacy(ratatui, { ...answer, kind: "framework" }),
      legacy(ratatui, { ...answer, kind: null }),
      legacy({ ...ratatui, readmeOid: null }, answer),
      hash(ratatui),
    ]);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(await legacy(ratatui, { ...answer, keywords: [...answer.keywords] })).toBe(hashes[0]);
  });
});
