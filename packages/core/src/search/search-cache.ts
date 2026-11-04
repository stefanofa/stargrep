import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Schema from "effect/Schema";

export class SearchCacheFailed extends Schema.TaggedError<SearchCacheFailed, { readonly brand: unique symbol }>()(
  "SearchCacheFailed",
  {
    operation: Schema.Literals(["get", "set"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Search cache '${this.operation}' failed`;
  }
}

export const stableTtl = Duration.days(30);

const envelopeFields = { text: Schema.String, expiresAt: Schema.Int };

type Envelope<A> = Schema.Struct.Type<typeof envelopeFields> & { readonly value: A };

export interface Entry<A> {
  readonly namespace: string;
  readonly schema: Schema.Codec<A, unknown>;
  readonly ttl: Duration.Duration;
  readonly decode: (raw: string) => Effect.Effect<Envelope<A>, Schema.SchemaError>;
  readonly encode: (envelope: Envelope<A>) => Effect.Effect<string, Schema.SchemaError>;
}

export const entry = <A, I>(options: {
  readonly namespace: string;
  readonly schema: Schema.Codec<A, I>;
  readonly ttl: Duration.Duration;
}): Entry<A> => {
  const record = Schema.fromJsonString(Schema.Struct({ ...envelopeFields, value: options.schema }));
  return {
    ...options,
    decode: Schema.decodeUnknownEffect(record),
    encode: Schema.encodeEffect(record),
  };
};

export interface Backend {
  readonly get: (key: string) => Effect.Effect<Option.Option<string>, SearchCacheFailed>;
  readonly set: (key: string, value: string, ttl: Duration.Duration) => Effect.Effect<void, SearchCacheFailed>;
}

export class SearchCache extends Context.Service<
  SearchCache,
  {
    readonly lookup: <A>(entry: Entry<A>, text: string) => Effect.Effect<Option.Option<A>>;
    readonly store: <A>(entry: Entry<A>, text: string, value: A) => Effect.Effect<void>;
  }
>()("@stargrep/core/search/search-cache/SearchCache") {}

const utf8 = new TextEncoder();

export const make = Effect.fnUntraced(function* (backend: Backend) {
  const digest = yield* Digest.Digest;
  const keyOf = (namespace: string, text: string) =>
    digest.digestHex(Digest.sha256, utf8.encode(text)).pipe(Effect.map((hash) => `${namespace}/${hash}`));

  const lookup = Effect.fn("SearchCache.lookup")(
    function* <A>(entry: Entry<A>, text: string) {
      const raw = yield* backend.get(yield* keyOf(entry.namespace, text));
      if (Option.isNone(raw)) return Option.none<A>();
      const record = yield* entry.decode(raw.value).pipe(
        Effect.catchTags({
          SchemaError: () =>
            Effect.logWarning("Search cache entry does not decode", { namespace: entry.namespace }).pipe(
              Effect.as(undefined),
            ),
        }),
      );
      const now = yield* Clock.currentTimeMillis;
      return record !== undefined && record.text === text && record.expiresAt > now
        ? Option.some(record.value)
        : Option.none<A>();
    },
    Effect.catchTags({
      SearchCacheFailed: (error) =>
        Effect.logWarning("Search cache read failed", { operation: error.operation }).pipe(Effect.as(Option.none())),
    }),
  );

  const store = Effect.fn("SearchCache.store")(
    function* <A>(entry: Entry<A>, text: string, value: A) {
      const expiresAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(entry.ttl);
      const encoded = yield* entry.encode({ text, expiresAt, value });
      yield* backend.set(yield* keyOf(entry.namespace, text), encoded, entry.ttl);
    },
    (effect, entry) =>
      effect.pipe(
        Effect.catchTags({
          SchemaError: () => Effect.logWarning("Search cache value does not encode", { namespace: entry.namespace }),
          SearchCacheFailed: (error) => Effect.logWarning("Search cache write failed", { operation: error.operation }),
        }),
      ),
  );

  return SearchCache.of({ lookup, store });
});

export const layerKeyValueStore = Layer.effect(
  SearchCache,
  Effect.gen(function* () {
    const store = KeyValueStore.prefix(yield* KeyValueStore.KeyValueStore, "search/");
    return yield* make({
      get: (key) =>
        store.get(key).pipe(
          Effect.map(Option.fromUndefinedOr),
          Effect.mapError((cause) => new SearchCacheFailed({ operation: "get", cause })),
        ),
      set: (key, value) =>
        store.set(key, value).pipe(Effect.mapError((cause) => new SearchCacheFailed({ operation: "set", cause }))),
    });
  }),
).pipe(Layer.provide(Digest.layerWebCrypto));

export const layerMemory = layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory));
