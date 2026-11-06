import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { useEffect, useState } from "react";
import { api, type SyncStatus } from "./rpc.ts";
import { readingIncomplete } from "./search-state.ts";
import { forgetRefusal, type Refusal, refusalOf, rememberRefusal } from "./trouble.ts";

const importing = Duration.seconds(2);
const inLine = Duration.seconds(10);
const reading = Duration.seconds(5);
const idle = Duration.seconds(30);

const firstImport = (status: SyncStatus) =>
  (status.state === "queued" || status.state === "waiting") && status.syncedAt === null;

const intervalOf = (status: SyncStatus | undefined) => {
  if (status?.state === "waiting") return inLine;
  if (status?.state === "queued") return importing;
  if (status !== undefined && readingIncomplete(status.enrichment)) return reading;
  return idle;
};

const libraryMoved = (before: SyncStatus | undefined, current: SyncStatus) =>
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

// A status read that fails is tried again at the next poll. A trigger that fails needs the visitor to ask again.
const readFailure = (cause: unknown) => new SyncFailed({ cause });

const triggerFailure = (cause: unknown) => new SyncRefused({ refusal: refusalOf(cause) });

export type SyncWatch =
  | { readonly kind: "watching"; readonly status: SyncStatus | undefined }
  | { readonly kind: Refusal };

// Rendering a page never starts an import, since crawlers and link previews render pages too. The browser asks once the
// page is hydrated and its tab is visible. A refusal, from this page or remembered from an earlier load, stays on screen
// until the visitor tries again, so the page never asks twice on its own.
export function useSync(login: string, onProgress: () => void, initial?: SyncStatus, refused?: Refusal) {
  const [watch, setWatch] = useState<SyncWatch>(
    refused === undefined ? { kind: "watching", status: initial } : { kind: refused },
  );
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (round === 0 && refused !== undefined) return;
    const client = api();
    const trigger = whenVisible.pipe(
      Effect.andThen(Effect.tryPromise({ try: () => client.triggerSync({ login }), catch: triggerFailure })),
      Effect.tap(() => Effect.sync(() => forgetRefusal(login))),
    );
    const read = Effect.tryPromise({ try: () => client.syncStatus({ login }), catch: readFailure }).pipe(
      Effect.filterOrElse(
        (current) => current.state !== "unknown",
        () => trigger,
      ),
    );
    const step = (ask: typeof read, before: SyncStatus | undefined) =>
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
              Effect.sync(() => {
                rememberRefusal(login, refusal);
                setWatch({ kind: refusal });
              }),
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
