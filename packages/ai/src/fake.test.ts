import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Embeddings from "./embeddings.ts";
import * as Fake from "./fake.ts";

const dot = (left: ReadonlyArray<number>, right: ReadonlyArray<number>) =>
  left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

describe("fake embeddings", () => {
  it.effect("embed related texts closer than unrelated ones", () =>
    Effect.gen(function* () {
      const embeddings = yield* Embeddings.Embeddings;
      const [query, related, unrelated] = yield* embeddings.embed([
        "terminal dashboard library",
        "library for terminal dashboards and charts",
        "photo editing app",
      ]);
      expect(dot(query?.vector ?? [], related?.vector ?? [])).toBeGreaterThan(
        dot(query?.vector ?? [], unrelated?.vector ?? []),
      );
    }).pipe(Effect.provide(Fake.layerEmbeddings())),
  );
});
