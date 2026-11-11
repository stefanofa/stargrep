import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { layerS3, type ObjectBucket, requestStore } from "./runtime.ts";

// The part of Bun's S3 client the R2 blob store uses, kept in memory. Each call takes the next of failures to throw, if
// any is left, and counts as an attempt.
const bucket = (objects: Map<string, string>, failures: Array<unknown> = []) => {
  const attempts = { count: 0 };
  const attempt = () => {
    attempts.count++;
    const failure = failures.shift();
    if (failure !== undefined) throw failure;
  };
  const client: ObjectBucket = {
    file: (key: string) => ({
      exists: async () => {
        attempt();
        return objects.has(key);
      },
      text: async () => objects.get(key) ?? "",
    }),
    write: async (key: string, value: string) => {
      attempt();
      objects.set(key, value);
      return value.length;
    },
  };
  return { client, attempts };
};

const s3Error = (code: string) =>
  Object.assign(new Error("an unexpected error has occurred"), { name: "S3Error", code });

it.effect("reads back what the R2 blob store wrote, and none for a key it never wrote", () =>
  Effect.gen(function* () {
    const objects = new Map<string, string>();
    const store = layerS3(bucket(objects).client);
    expect(yield* store.get("prefill/requests/a.json")).toEqual(Option.none());
    yield* store.put("prefill/requests/a.json", "{}");
    expect(yield* store.get("prefill/requests/a.json")).toEqual(Option.some("{}"));
    expect([...objects.keys()]).toEqual(["prefill/requests/a.json"]);
  }),
);

// Pilot 3 stopped on one R2 get that failed this way.
it.effect("reads and writes through R2 errors that pass, such as the unexpected error pilot 3 hit", () =>
  Effect.gen(function* () {
    const objects = new Map([["readmes/a", "# a"]]);
    const { client, attempts } = bucket(objects, [s3Error("UnknownError"), new Error("connection reset")]);
    const store = layerS3(client);
    const read = yield* Effect.forkChild(store.get("readmes/a"));
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(read)).toEqual(Option.some("# a"));
    expect(attempts.count).toBe(3);
  }),
);

it.effect("fails with BlobStoreFailed naming the key once R2 stays unreachable for five tries", () =>
  Effect.gen(function* () {
    const { client, attempts } = bucket(
      new Map(),
      Array.from({ length: 10 }, () => new Error("connection reset")),
    );
    const store = layerS3(client);
    const write = yield* Effect.forkChild(Effect.flip(store.put("prefill/requests/b.json", "{}")));
    yield* TestClock.adjust("1 minute");
    const failed = yield* Fiber.join(write);
    expect([failed._tag, failed.operation, failed.key]).toEqual(["BlobStoreFailed", "put", "prefill/requests/b.json"]);
    expect(attempts.count).toBe(5);
  }),
);

it.effect("fails at once on an error that repeats, such as a refused key or a missing bucket", () =>
  Effect.gen(function* () {
    for (const failure of [s3Error("AccessDenied"), s3Error("NoSuchBucket"), s3Error("ERR_S3_MISSING_CREDENTIALS")]) {
      const { client, attempts } = bucket(new Map(), [failure]);
      const failed = yield* Effect.flip(layerS3(client).get("readmes/c"));
      expect([failed._tag, attempts.count]).toEqual(["BlobStoreFailed", 1]);
    }
  }),
);

it.effect("keeps a Gateway batch run's requests in R2 only, and refuses one without a bucket", () =>
  Effect.sync(() => {
    const bucket = Option.some("readmes");
    expect(requestStore("batch", "gateway", Option.none())._tag).toBe("Failure");
    expect(requestStore("batch", "gateway", bucket)).toEqual(Result.succeed("r2"));
    expect(requestStore("batch", "fake", Option.none())).toEqual(Result.succeed("local"));
    expect(requestStore("cli", "claude-code", Option.none())).toEqual(Result.succeed("local"));
    expect(requestStore("batch", "claude-code", bucket)._tag).toBe("Failure");
  }),
);
