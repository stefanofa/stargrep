import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { useEffect, useState } from "react";
import { type PlannedSyncStatus, planned } from "./planned.ts";
import { type Refusal, refusalOf } from "./refusals.ts";
import { api } from "./rpc.ts";
import { readingIncomplete } from "./search-state.ts";

const importing = Duration.seconds(2);
const inLine = Duration.seconds(10);
const reading = Duration.seconds(5);
const idle = Duration.seconds(30);

const firstImport = (status: PlannedSyncStatus) =>
  (status.state === "queued" || status.state === "waiting") && status.syncedAt === null;

const intervalOf = (status: PlannedSyncStatus | undefined) => {
  if (status?.state === "waiting") return inLine;
  if (status?.state === "queued") return importing;
  if (status !== undefined && readingIncomplete(status.enrichment)) return reading;
  return idle;
};

const libraryMoved = (before: PlannedSyncStatus | undefined, current: PlannedSyncStatus) =>
  firstImport(current) ||
  (before !== undefined &&
    ((before.state === "queued" && current.state !== "queued") ||
      before.enrichment.read !== current.enrichment.read ||
      before.enrichment.total !== current.enrichment.total));

const visible = Effect.callback<void>((resume) => {
  const onChange = () => {
    if (document.visibilityState === "visible") resume(Effect.void);
  };
  document.addEventListener("visibilitychange", onChange);
  return Effect.sync(() => document.removeEventListener("visibilitychange", onChange));
});

const whenVisible = Effect.suspend(() => (document.visibilityState === "visible" ? Effect.void : visible));

class SyncRefused extends Data.TaggedError("SyncRefused")<{ readonly refusal: Refusal }> {}

class SyncFailed extends Data.TaggedError("SyncFailed")<{ readonly cause: unknown }> {}

const failure = (cause: unknown) => {
  const refusal = refusalOf(cause);
  return refusal === undefined ? new SyncFailed({ cause }) : new SyncRefused({ refusal });
};

export type SyncWatch =
  | { readonly kind: "watching"; readonly status: PlannedSyncStatus | undefined }
  | { readonly kind: Refusal };

// The server may already have read the status, or have been refused when it asked for the sync. A refusal stays on
// screen until the visitor tries again, so the page never asks twice on its own.
export function useSync(login: string, onProgress: () => void, initial?: PlannedSyncStatus, refused?: Refusal) {
  const [watch, setWatch] = useState<SyncWatch>(
    refused === undefined ? { kind: "watching", status: initial } : { kind: refused },
  );
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (round === 0 && refused !== undefined) return;
    const client = planned(api());
    const trigger = Effect.tryPromise({ try: () => client.triggerSync({ login }), catch: failure });
    const read = Effect.tryPromise({ try: () => client.syncStatus({ login }), catch: failure }).pipe(
      Effect.filterOrElse(
        (current) => current.state !== "unknown",
        () => trigger,
      ),
    );
    const step = (ask: typeof read, before: PlannedSyncStatus | undefined) =>
      ask.pipe(
        Effect.tap((current) =>
          Effect.sync(() => {
            setWatch({ kind: "watching", status: current });
            if (libraryMoved(before, current)) onProgress();
          }),
        ),
        Effect.catchTags({
          SyncRefused: ({ refusal }) =>
            Effect.andThen(
              Effect.sync(() => setWatch({ kind: refusal })),
              Effect.never,
            ),
          SyncFailed: (error) => Effect.as(Effect.logWarning("sync status failed", error.cause), before),
        }),
      );
    const poll = Effect.gen(function* () {
      let current = yield* step(round === 0 ? read : trigger, initial);
      while (true) {
        yield* Effect.raceFirst(Effect.sleep(intervalOf(current)), visible);
        yield* whenVisible;
        current = yield* step(read, current);
      }
    });
    const fiber = Effect.runFork(poll);
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [login, onProgress, round, initial, refused]);

  return { watch, retry: () => setRound((value) => value + 1) };
}
