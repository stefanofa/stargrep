import { expect } from "bun:test";
import { blobOid } from "@stargrep/github/blob-oid";
import * as GitHubFake from "@stargrep/github/github.fixture";
import { ObjectId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as BlobStore from "./blob-store.ts";
import { adapters, fixture, query, range, ref, run, tally } from "./prefill.fixture.ts";
import * as Prefill from "./prefill.ts";

const oidOf = (text: string) =>
  Effect.map(blobOid(new TextEncoder().encode(text)), ObjectId.make).pipe(Effect.provide(Digest.layerWebCrypto));

// A repo whose README carries its real object ID, so a GraphQL batch can return it.
const held = Effect.fn("test.held")(function* (n: number, readme: string) {
  return { description: `A CLI for task ${n}`, readme, readmeOid: yield* oidOf(readme) };
});

// The repo node IDs the latest README batch asked for.
const batchedRepos = (sent: ReadonlyArray<GitHubFake.Sent>) => {
  const batch = sent.findLast((entry) => (entry.body ?? "").includes("query Readmes"));
  const variables: Record<string, string> = JSON.parse(batch?.body ?? "{}").variables ?? {};
  return Object.entries(variables).flatMap(([key, value]) => (key.startsWith("r") ? [value] : []));
};

const readmeOf = (n: number) =>
  Effect.flatMap(query("select readme_oid from repos where id = $1", [n]), ([row]) =>
    Effect.flatMap(BlobStore.BlobStore, (blobs) =>
      blobs.get(BlobStore.readmeKey(ObjectId.make((row as { readme_oid: string }).readme_oid))),
    ),
  );

for (const [adapter, database] of adapters) {
  const f = fixture();

  it.layer(f.layer(database), { timeout: 60_000, testTimeout: 60_000 })(`prefill README reads on ${adapter}`, (it) => {
    it.effect(
      "reads the READMEs the blob store lacks in one GraphQL batch, and over REST only those it leaves out",
      () =>
        Effect.gen(function* () {
          const blobs = yield* BlobStore.BlobStore;
          f.remotes.set(8001, yield* held(8001, "# repo-8001\n\nA CLI."));
          f.remotes.set(8002, yield* held(8002, "# repo-8002\n\nA CLI."));
          // GraphQL returns a text that does not hash to this README's object ID, as for one it cut short.
          f.remotes.set(8003, { description: "A CLI for task 8003", readme: "# repo-8003\n\nA CLI." });
          f.remotes.set(8004, { ...(yield* held(8004, "# repo-8004")), readmeGone: true });
          const cached = yield* held(8005, "# repo-8005\n\nRead before.");
          f.remotes.set(8005, cached);
          yield* blobs.put(BlobStore.readmeKey(cached.readmeOid), cached.readme);
          const before = f.readmeReads();
          const report = yield* run(range(8001, 5).map(ref));
          expect(tally(report)).toEqual({ saved: 4, unreadable: 1 });
          const after = f.readmeReads();
          expect({ batches: after.batches - before.batches, rest: after.rest - before.rest }).toEqual({
            batches: 1,
            rest: 2,
          });
          expect(batchedRepos(f.github.sent)).toEqual(["R_8001", "R_8002", "R_8003", "R_8004"]);
          expect(yield* Effect.forEach([8001, 8002, 8003, 8005], readmeOf)).toEqual([
            Option.some("# repo-8001\n\nA CLI."),
            Option.some("# repo-8002\n\nA CLI."),
            Option.some("# repo-8003\n\nA CLI."),
            Option.some("# repo-8005\n\nRead before."),
          ]);
        }),
    );

    it.effect("stores the same README and sends the same request with the same input hashes as a REST read", () =>
      Effect.gen(function* () {
        // A byte order mark, Windows line endings, and text outside ASCII, which a REST body decodes in its own way.
        const readme = "﻿# repo-8101\r\n\r\nA CLI for 日本語 users 🚀\r\n";
        const remote = yield* held(8101, readme);
        const prefillVia = (batch: boolean) => {
          const stack = fixture();
          stack.readmeBatches.on = batch;
          stack.remotes.set(8101, remote);
          return Effect.gen(function* () {
            const blobs = yield* BlobStore.BlobStore;
            const report = yield* run([ref(8101)]);
            const [manifest] = (yield* query("select request_key, input_hashes from extraction_batches")) as Array<{
              readonly request_key: string;
            }>;
            return {
              report: tally(report),
              readme: yield* blobs.get(BlobStore.readmeKey(remote.readmeOid)),
              repo: yield* query("select readme_oid, input_hash, summary_input_hash from repos where id = 8101"),
              manifest,
              request: yield* blobs.get(Prefill.requestObjectKey(manifest?.request_key ?? "")),
              reads: stack.readmeReads(),
            };
          }).pipe(Effect.provide(Layer.fresh(stack.layer(database))));
        };
        const { reads: restReads, ...viaRest } = yield* prefillVia(false);
        const { reads: batchReads, ...viaBatch } = yield* prefillVia(true);
        expect([restReads, batchReads]).toEqual([
          { batches: 1, rest: 1 },
          { batches: 1, rest: 0 },
        ]);
        expect(viaRest.report).toEqual({ saved: 1 });
        expect(viaRest.readme).toEqual(Option.some(readme.slice(1)));
        expect(viaBatch).toEqual(viaRest);
      }),
    );

    it.effect("waits for a rate limit on a README batch to lift, then reads the batch", () =>
      Effect.gen(function* () {
        f.remotes.set(8201, yield* held(8201, "# repo-8201\n\nA CLI."));
        const now = yield* Clock.currentTimeMillis;
        const resetSeconds = Math.ceil(now / 1000) + 120;
        f.readmeBatches.replies.push({
          headers: GitHubFake.rateLimitHeaders(0, resetSeconds, "graphql"),
          body: { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
        });
        const logs = yield* Queue.unbounded<unknown>();
        const logged = Logger.layer([Logger.make(({ message }) => Queue.offerUnsafe(logs, message))]);
        const before = f.readmeReads();
        const running = yield* Effect.forkChild(run([ref(8201)]).pipe(Effect.provide(logged)));
        const waiting = yield* Queue.take(logs).pipe(
          Effect.repeat({ until: (message) => JSON.stringify(message).includes("waits for GitHub's limit") }),
        );
        expect(waiting).toEqual(["Prefill waits for GitHub's limit to lift", { resource: "graphql", seconds: 120 }]);
        yield* TestClock.adjust(Duration.millis(resetSeconds * 1000 - now));
        const report = yield* Fiber.join(running);
        expect(tally(report)).toEqual({ saved: 1 });
        const after = f.readmeReads();
        expect({ batches: after.batches - before.batches, rest: after.rest - before.rest }).toEqual({
          batches: 2,
          rest: 0,
        });
        const batches = f.github.sent.filter((sent) => (sent.body ?? "").includes("query Readmes")).slice(-2);
        expect(batches.map((sent) => sent.startedAt)).toEqual([now, resetSeconds * 1000]);
      }),
    );
  });
}
