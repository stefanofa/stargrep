import type { RepoId } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class EnrichQueueFailed extends Schema.TaggedError<EnrichQueueFailed, { readonly brand: unique symbol }>()(
  "EnrichQueueFailed",
  {
    repos: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Sending ${this.repos} repos to the enrich queue failed`;
  }
}

export class EnrichQueue extends Context.Service<
  EnrichQueue,
  {
    readonly send: (ids: ReadonlyArray<RepoId>) => Effect.Effect<void, EnrichQueueFailed>;
  }
>()("@stargrep/core/stars/enrich-queue/EnrichQueue") {}

export const layerMemory = (sent: Array<RepoId>) =>
  Layer.succeed(
    EnrichQueue,
    EnrichQueue.of({
      send: Effect.fn("EnrichQueue.send")(function* (ids: ReadonlyArray<RepoId>) {
        yield* Effect.sync(() => sent.push(...ids));
      }),
    }),
  );
