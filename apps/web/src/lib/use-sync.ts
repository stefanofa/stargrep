import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { useEffect, useState } from "react";
import { api, type SyncStatus } from "./rpc.ts";
import { readingIncomplete } from "./search-state.ts";

const importing = Duration.seconds(2);
const reading = Duration.seconds(5);
const idle = Duration.seconds(30);

const firstImport = (status: SyncStatus) => status.state === "queued" && status.syncedAt === null;

const intervalOf = (status: SyncStatus | undefined) => {
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

export function useSync(login: string, onProgress: () => void) {
  const [status, setStatus] = useState<SyncStatus>();
  const [round, setRound] = useState(0);

  useEffect(() => {
    const trigger = Effect.tryPromise(() => api().triggerSync({ login }));
    const read = Effect.tryPromise(() => api().syncStatus({ login })).pipe(
      Effect.filterOrElse(
        (current) => current.state !== "unknown",
        () => trigger,
      ),
    );
    const step = (ask: typeof read, before: SyncStatus | undefined) =>
      ask.pipe(
        Effect.tap((current) =>
          Effect.sync(() => {
            setStatus(current);
            if (libraryMoved(before, current)) onProgress();
          }),
        ),
        Effect.catch((error) => Effect.as(Effect.logWarning("sync status failed", error), before)),
      );
    const poll = Effect.gen(function* () {
      let current = yield* step(round === 0 ? read : trigger, undefined);
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
  }, [login, onProgress, round]);

  return { status, retry: () => setRound((value) => value + 1) };
}
