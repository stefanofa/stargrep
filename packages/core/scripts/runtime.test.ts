import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { layerS3, type ObjectBucket } from "./runtime.ts";

// The part of Bun's S3 client the R2 blob store uses, kept in memory.
const bucket = (objects: Map<string, string>, failing = false): ObjectBucket => ({
  file: (key: string) => ({
    exists: async () => {
      if (failing) throw new Error("connection reset");
      return objects.has(key);
    },
    text: async () => objects.get(key) ?? "",
  }),
  write: async (key: string, value: string) => {
    if (failing) throw new Error("connection reset");
    objects.set(key, value);
    return value.length;
  },
});

it.effect("reads back what the R2 blob store wrote, and none for a key it never wrote", () =>
  Effect.gen(function* () {
    const objects = new Map<string, string>();
    const store = layerS3(bucket(objects));
    expect(yield* store.get("prefill/requests/a.json")).toEqual(Option.none());
    yield* store.put("prefill/requests/a.json", "{}");
    expect(yield* store.get("prefill/requests/a.json")).toEqual(Option.some("{}"));
    expect([...objects.keys()]).toEqual(["prefill/requests/a.json"]);
  }),
);

it.effect("fails with BlobStoreFailed naming the key when R2 cannot be reached", () =>
  Effect.gen(function* () {
    const store = layerS3(bucket(new Map(), true));
    const failed = yield* Effect.flip(store.put("prefill/requests/b.json", "{}"));
    expect([failed._tag, failed.operation, failed.key]).toEqual(["BlobStoreFailed", "put", "prefill/requests/b.json"]);
  }),
);
