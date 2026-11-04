import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Schema from "effect/Schema";

export class BlobStoreFailed extends Schema.TaggedError<BlobStoreFailed, { readonly brand: unique symbol }>()(
  "BlobStoreFailed",
  {
    operation: Schema.Literals(["get", "put"]),
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Blob store '${this.operation}' failed for '${this.key}'`;
  }
}

export class BlobStore extends Context.Service<
  BlobStore,
  {
    readonly get: (key: string) => Effect.Effect<Option.Option<string>, BlobStoreFailed>;
    readonly put: (key: string, value: string) => Effect.Effect<void, BlobStoreFailed>;
  }
>()("@stargrep/core/repos/blob-store/BlobStore") {}

export const layerKeyValueStore = Layer.effect(
  BlobStore,
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    return BlobStore.of({
      get: Effect.fn("BlobStore.get")(function* (key: string) {
        const value = yield* store
          .get(key)
          .pipe(Effect.mapError((cause) => new BlobStoreFailed({ operation: "get", key, cause })));
        return Option.fromUndefinedOr(value);
      }),
      put: Effect.fn("BlobStore.put")(function* (key: string, value: string) {
        yield* store
          .set(key, value)
          .pipe(Effect.mapError((cause) => new BlobStoreFailed({ operation: "put", key, cause })));
      }),
    });
  }),
);

export const layerMemory = layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerMemory));
