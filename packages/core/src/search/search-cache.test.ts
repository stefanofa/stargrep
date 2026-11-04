import { expect } from "bun:test";
import { embeddingDimensions, Float32Vector } from "@stargrep/db/embedding";
import * as it from "@stargrep/testing";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SearchCache from "./search-cache.ts";

const counts = SearchCache.entry({
  namespace: "test/counts",
  schema: Schema.Struct({ count: Schema.Int }),
  ttl: Duration.hours(1),
});

const backend = () => {
  const rows = new Map<string, { readonly value: string; readonly ttl: Duration.Duration }>();
  const cache = Layer.effect(
    SearchCache.SearchCache,
    SearchCache.make({
      get: (key) => Effect.sync(() => Option.fromUndefinedOr(rows.get(key)?.value)),
      set: (key, value, ttl) => Effect.sync(() => void rows.set(key, { value, ttl })),
    }),
  ).pipe(Layer.provide(Digest.layerWebCrypto));
  return { rows, cache };
};

const lookup = <A>(entry: SearchCache.Entry<A>, text: string) =>
  Effect.flatMap(Effect.service(SearchCache.SearchCache), (cache) => cache.lookup(entry, text));

const store = <A>(entry: SearchCache.Entry<A>, text: string, value: A) =>
  Effect.flatMap(Effect.service(SearchCache.SearchCache), (cache) => cache.store(entry, text, value));

it.effect("stores a value under a SHA-256 key in its namespace and reads it back", () => {
  const { rows, cache } = backend();
  return Effect.gen(function* () {
    yield* store(counts, "rust tui", { count: 3 });
    expect([...rows.keys()][0]).toMatch(/^test\/counts\/[0-9a-f]{64}$/);
    expect(rows.values().next().value?.ttl).toEqual(Duration.hours(1));
    expect(yield* lookup(counts, "rust tui")).toEqual(Option.some({ count: 3 }));
    expect(yield* lookup(counts, "rust tuis")).toEqual(Option.none());
  }).pipe(Effect.provide(cache));
});

it.effect("misses when the stored entry was written for other text under the same key", () => {
  const { rows, cache } = backend();
  return Effect.gen(function* () {
    yield* store(counts, "first", { count: 1 });
    const [key] = [...rows.keys()];
    rows.set(key ?? "", {
      value: JSON.stringify({ text: "second", expiresAt: 8.64e15, value: { count: 2 } }),
      ttl: Duration.hours(1),
    });
    expect(yield* lookup(counts, "first")).toEqual(Option.none());
  }).pipe(Effect.provide(cache));
});

it.effect("misses on a corrupt entry instead of failing", () => {
  const { rows, cache } = backend();
  return Effect.gen(function* () {
    yield* store(counts, "first", { count: 1 });
    const [key] = [...rows.keys()];
    for (const corrupt of [
      "not json",
      JSON.stringify({ text: "first", expiresAt: 8.64e15, value: { count: "many" } }),
    ]) {
      rows.set(key ?? "", { value: corrupt, ttl: Duration.hours(1) });
      expect(yield* lookup(counts, "first")).toEqual(Option.none());
    }
  }).pipe(Effect.provide(cache));
});

it.effect("expires an entry after its TTL on any backend", () =>
  Effect.gen(function* () {
    const stable = SearchCache.entry({ namespace: "test/stable", schema: Schema.Int, ttl: SearchCache.stableTtl });
    yield* store(stable, "a query", 7);
    yield* TestClock.adjust("29 days");
    expect(yield* lookup(stable, "a query")).toEqual(Option.some(7));
    yield* TestClock.adjust("2 days");
    expect(yield* lookup(stable, "a query")).toEqual(Option.none());
  }).pipe(Effect.provide(SearchCache.layerMemory)),
);

it.effect("misses on a cached vector of the wrong byte length instead of dying", () => {
  const vectors = SearchCache.entry({ namespace: "test/vectors", schema: Float32Vector, ttl: SearchCache.stableTtl });
  const base64 = (bytes: number) => Buffer.from(new Uint8Array(bytes)).toString("base64");
  const values: ReadonlyArray<unknown> = ["AQ==", "AQI=", "AQID", base64(embeddingDimensions * 2), "garbage", "", null];
  return Effect.forEach(values, (value) => {
    const corrupt = Layer.effect(
      SearchCache.SearchCache,
      SearchCache.make({
        get: () => Effect.succeedSome(JSON.stringify({ text: "query", expiresAt: 8.64e15, value })),
        set: () => Effect.void,
      }),
    ).pipe(Layer.provide(Digest.layerWebCrypto));
    return lookup(vectors, "query").pipe(
      Effect.map((hit) => expect([value, hit]).toEqual([value, Option.none()])),
      Effect.provide(corrupt),
    );
  });
});

it.effect("turns backend failures into a miss and a dropped write", () => {
  const down = new Error("kv down");
  const cache = Layer.effect(
    SearchCache.SearchCache,
    SearchCache.make({
      get: () => Effect.fail(new SearchCache.SearchCacheFailed({ operation: "get", cause: down })),
      set: () => Effect.fail(new SearchCache.SearchCacheFailed({ operation: "set", cause: down })),
    }),
  ).pipe(Layer.provide(Digest.layerWebCrypto));
  return Effect.gen(function* () {
    yield* store(counts, "first", { count: 1 });
    expect(yield* lookup(counts, "first")).toEqual(Option.none());
  }).pipe(Effect.provide(cache));
});

it.effect("keeps entries in memory for the length of the layer", () =>
  Effect.gen(function* () {
    yield* store(counts, "first", { count: 7 });
    expect(yield* lookup(counts, "first")).toEqual(Option.some({ count: 7 }));
  }).pipe(Effect.provide(SearchCache.layerMemory)),
);
