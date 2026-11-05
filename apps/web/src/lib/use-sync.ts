import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { useEffect, useState } from "react";
import { api, type SyncStatus } from "./rpc.ts";

const importing = Duration.seconds(2);
const reading = Duration.seconds(5);

const stillReading = ({ enrichment }: SyncStatus) => enrichment.read + enrichment.failed < enrichment.total;

const readCount = (status: SyncStatus | undefined) => status?.enrichment.read;

export function useSync(login: string, onProgress: () => void) {
  const [status, setStatus] = useState<SyncStatus>();
  const [round, setRound] = useState(0);

  useEffect(() => {
    const ask = (call: () => Promise<SyncStatus>) => Effect.tryPromise(call);
    const trigger = ask(() => api().triggerSync({ login }));
    const read = ask(() => api().syncStatus({ login })).pipe(
      Effect.filterOrElse(
        (current) => current.state !== "unknown",
        () => trigger,
      ),
    );
    let previous: SyncStatus | undefined;
    const publish = (current: SyncStatus) =>
      Effect.sync(() => {
        setStatus(current);
        const syncing = previous?.state === "queued" || current.state === "queued";
        const readMore = previous !== undefined && readCount(current) !== readCount(previous);
        if (syncing || readMore) onProgress();
        previous = current;
      });
    const poll = Effect.gen(function* () {
      let current = yield* round === 0 ? read : trigger;
      yield* publish(current);
      while (current.state === "queued" || stillReading(current)) {
        yield* Effect.sleep(current.state === "queued" ? importing : reading);
        current = yield* read;
        yield* publish(current);
      }
    });
    const fiber = Effect.runFork(Effect.ignore(poll));
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [login, onProgress, round]);

  return { status, retry: () => setRound((value) => value + 1) };
}
