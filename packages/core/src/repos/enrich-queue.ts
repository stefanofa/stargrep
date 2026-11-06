import { UserId } from "@stargrep/db/auth-schema";
import { RepoId } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const EnrichRepo = Schema.Struct({
  repoId: RepoId,
  // The signed-in user whose import brought the repo in. Their token pays for its GitHub reads. A sweep's repo has none.
  userId: Schema.optionalKey(UserId),
});
export type EnrichRepo = typeof EnrichRepo.Type;

export class EnrichQueueFailed extends Schema.TaggedError<EnrichQueueFailed, { readonly brand: unique symbol }>()(
  "EnrichQueueFailed",
  {
    messages: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Sending ${this.messages} messages to the enrich queue failed`;
  }
}

export class EnrichQueue extends Context.Service<
  EnrichQueue,
  {
    readonly send: (messages: ReadonlyArray<EnrichRepo>) => Effect.Effect<void, EnrichQueueFailed>;
  }
>()("@stargrep/core/repos/enrich-queue/EnrichQueue") {}

export const layerMemory = () => {
  const sent: Array<EnrichRepo> = [];
  const layer = Layer.succeed(
    EnrichQueue,
    EnrichQueue.of({
      send: Effect.fn("EnrichQueue.send")(function* (messages: ReadonlyArray<EnrichRepo>) {
        yield* Effect.sync(() => sent.push(...messages));
      }),
    }),
  );
  return { sent, layer };
};
