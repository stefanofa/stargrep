import type * as Db from "@stargrep/db";
import { Login, ObjectId, type RepoFacts, RepoFile, RepoId, RepoName } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const IconRequest = Schema.TaggedStruct("IconRequest", {
  repoId: RepoId,
  owner: Login,
  name: RepoName,
  homepage: Schema.NullOr(Schema.String),
  iconFiles: Schema.Array(RepoFile),
  readmeOid: Schema.NullOr(ObjectId),
});
export type IconRequest = typeof IconRequest.Type;

export const BackfillIcons = Schema.TaggedStruct("BackfillIcons", {
  after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type BackfillIcons = typeof BackfillIcons.Type;

export const IconMessage = Schema.Union([IconRequest, BackfillIcons]);
export type IconMessage = typeof IconMessage.Type;

export const iconRequest = (facts: RepoFacts): IconRequest =>
  IconRequest.make({
    repoId: facts.id,
    owner: facts.owner,
    name: facts.name,
    homepage: facts.homepage,
    iconFiles: facts.iconFiles,
    readmeOid: facts.readme?.oid ?? null,
  });

// Root icon files can change without either of these, and the periodic refresh catches that.
export const needsIconCheck = (row: Db.StoredRepo, facts: RepoFacts) =>
  row.iconCheckedAt === null || row.readmeOid !== (facts.readme?.oid ?? null) || row.homepage !== facts.homepage;

export class IconQueueFailed extends Schema.TaggedError<IconQueueFailed, { readonly brand: unique symbol }>()(
  "IconQueueFailed",
  {
    messages: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Sending ${this.messages} messages to the icon queue failed`;
  }
}

export class IconQueue extends Context.Service<
  IconQueue,
  { readonly send: (messages: ReadonlyArray<IconMessage>) => Effect.Effect<void, IconQueueFailed> }
>()("@stargrep/core/icons/icon-queue/IconQueue") {}

export const layerMemory = () => {
  const sent: Array<IconMessage> = [];
  const layer = Layer.succeed(
    IconQueue,
    IconQueue.of({
      send: Effect.fn("IconQueue.send")(function* (messages: ReadonlyArray<IconMessage>) {
        yield* Effect.sync(() => sent.push(...messages));
      }),
    }),
  );
  return { sent, layer };
};
