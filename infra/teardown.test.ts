import { expect, test } from "bun:test";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { AuthProvidersLive } from "alchemy/Auth/AuthProvider";
import * as Deploy from "alchemy/Deploy";
import * as Destroy from "alchemy/Destroy";
import * as Interaction from "alchemy/Interaction";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Stack from "alchemy/Stack";
import { inMemoryState } from "alchemy/State/InMemoryState";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { declare, previewEnv } from "./declare-app.ts";

class BucketNotEmpty extends Data.TaggedError("BucketNotEmpty")<{ readonly bucket: string }> {}

interface Bucket
  extends Resource<"Teardown.Bucket", { readonly forceDestroy?: boolean | undefined }, { readonly name: string }> {}
const Bucket = Resource<Bucket>("Teardown.Bucket");

// Deploys one bucket with the given props, writes a receipt into it, and destroys the stage the way preview-destroy
// and the provider switch do: from saved state alone, never from the current declaration. Deletion follows the R2
// provider, which empties a bucket only when its saved props say forceDestroy.
const teardown = (props: { readonly forceDestroy?: boolean | undefined }) => {
  const objects = new Map<string, Set<string>>();
  const providers = Provider.succeed(Bucket, {
    list: () => Effect.succeed([]),
    diff: () => Effect.void,
    reconcile: ({ id, output }) =>
      Effect.sync(() => {
        if (output) return output;
        objects.set(id, new Set());
        return { name: id };
      }),
    delete: Effect.fn(function* ({ id, olds }) {
      const contents = objects.get(id) ?? new Set();
      if (olds.forceDestroy === true) contents.clear();
      if (contents.size > 0) return yield* new BucketNotEmpty({ bucket: id });
      objects.delete(id);
    }),
  });
  const state = inMemoryState({}, {});
  return Effect.gen(function* () {
    const stack = { stackName: "Teardown", providers, state };
    yield* Deploy.deploy({
      stack: Stack.make({ name: "Teardown", providers, state })(Bucket("DebugBlobs", props)),
      stage: "pr-7",
    });
    objects.get("DebugBlobs")?.add("consumed/receipt");
    const destroyed = yield* Effect.exit(Destroy.destroy({ stack, stage: "pr-7" }));
    return { destroyed: Exit.isSuccess(destroyed), buckets: [...objects.keys()] };
  }).pipe(
    Effect.provideService(ArtifactStore, createArtifactStore()),
    Effect.provide(Layer.mergeAll(Interaction.layerNonInteractive(), AuthProvidersLive, state)),
    Effect.runPromise,
  );
};

test("a destroy that reads only saved state deletes every bucket a preview declares today, receipts and all", async () => {
  const { resources } = await Effect.runPromise(declare("pr-7", previewEnv));
  const deleted = Object.entries(resources).filter(
    ([, resource]) => resource.Type === "Cloudflare.R2.Bucket" && resource.RemovalPolicy !== "retain",
  );
  expect(deleted.map(([id]) => id).sort()).toEqual(["DebugBlobs", "Icons", "Readmes"]);
  for (const [, bucket] of deleted)
    expect(await teardown({ forceDestroy: bucket.Props.forceDestroy })).toEqual({ destroyed: true, buckets: [] });
});

test("a bucket saved without forceDestroy blocks the destroy, whatever the current declaration says", async () => {
  expect(await teardown({})).toEqual({ destroyed: false, buckets: ["DebugBlobs"] });
});
