import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { SyncStatus } from "./rpc.ts";
import { firstImport, readingIncomplete } from "./sync-status.ts";
import type { Refusal } from "./trouble.ts";

const intervalOf = (status: SyncStatus | undefined) => {
  if (status?.state === "waiting") return Duration.seconds(10);
  if (status?.state === "queued") return Duration.seconds(2);
  if (status !== undefined && readingIncomplete(status.enrichment)) return Duration.seconds(5);
  return Duration.seconds(30);
};
const libraryMoved = (before: SyncStatus | undefined, current: SyncStatus) =>
  firstImport(current) ||
  (before !== undefined &&
    ((before.state === "queued" && current.state !== "queued") ||
      before.enrichment.read !== current.enrichment.read ||
      before.enrichment.total !== current.enrichment.total));

export class SyncRefused extends Data.TaggedError("SyncRefused")<{ readonly refusal: Refusal }> {}
export class SyncFailed extends Data.TaggedError("SyncFailed")<{ readonly cause: unknown }> {}
// The page records when it read a status, because the server's status carries no time.
export type SyncWatch =
  | { readonly kind: "watching"; readonly status: SyncStatus | undefined; readonly at: number | undefined }
  | { readonly kind: Refusal };

interface Watch {
  readonly initial: SyncStatus | undefined;
  readonly retry: boolean;
  // The owner's page asks for a sync on every open, since only a sync finds a star made on GitHub. A refused ask of
  // theirs reads the status instead, so their library stays on screen.
  readonly own: boolean;
  readonly read: Effect.Effect<SyncStatus, SyncFailed>;
  readonly trigger: Effect.Effect<SyncStatus, SyncRefused>;
  readonly visible: Effect.Effect<void>;
  readonly whenVisible: Effect.Effect<void>;
  readonly changed: (watch: SyncWatch) => void;
  readonly progressed: () => void;
  readonly refused: (refusal: Refusal) => void;
}

export const watchSync = Effect.fn("Sync.watch")(function* (watch: Watch) {
  const trigger = Effect.andThen(watch.whenVisible, watch.trigger);
  const read = watch.read.pipe(
    Effect.flatMap((current) => {
      switch (current.state) {
        case "unknown":
          return trigger;
        case "missing":
          return Effect.fail(new SyncRefused({ refusal: "missing" }));
        default:
          return Effect.succeed(current);
      }
    }),
  );
  const step = (ask: typeof read, before: SyncStatus | undefined) =>
    ask.pipe(
      Effect.tap((current) =>
        Effect.flatMap(Clock.currentTimeMillis, (at) =>
          Effect.sync(() => {
            watch.changed({ kind: "watching", status: current, at });
            if (libraryMoved(before, current)) watch.progressed();
          }),
        ),
      ),
      Effect.catchTags({
        SyncRefused: ({ refusal }) =>
          Effect.andThen(
            Effect.sync(() => {
              watch.refused(refusal);
              watch.changed({ kind: refusal });
            }),
            Effect.never,
          ),
        // Failed reads retry at the next poll. A refused trigger waits for the visitor to ask again.
        SyncFailed: (error) => Effect.as(Effect.logWarning("sync status failed", error.cause), before),
      }),
    );
  const opening = watch.own ? Effect.catchTag(trigger, "SyncRefused", () => watch.read) : watch.retry ? trigger : read;
  let current = yield* step(opening, watch.initial);
  while (true) {
    yield* Effect.raceFirst(Effect.sleep(intervalOf(current)), watch.visible);
    yield* watch.whenVisible;
    current = yield* step(read, current);
  }
});
