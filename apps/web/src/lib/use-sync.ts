import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { useEffect, useState } from "react";
import { api, type SyncStatus } from "./rpc.ts";

const every = Duration.seconds(2);

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
    const publish = (current: SyncStatus) =>
      Effect.sync(() => {
        setStatus(current);
        onProgress();
      });
    const poll = Effect.gen(function* () {
      let current = yield* round === 0 ? read : trigger;
      yield* publish(current);
      while (current.state === "queued") {
        yield* Effect.sleep(every);
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
