import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import { useEffect, useState } from "react";
import { api, type SyncStatus } from "./rpc.ts";

const every = Duration.seconds(2);

// While a sync runs, the page reads its status and reloads the library every two seconds, so the count climbs as
// GitHub's pages land. A login Stargrep never synced gets its first sync here.
export function useSync(login: string, onProgress: () => void) {
  const [status, setStatus] = useState<SyncStatus>();
  const [round, setRound] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new round restarts the polling after a retry.
  useEffect(() => {
    const ask = (call: () => Promise<SyncStatus>) => Effect.tryPromise(call);
    const poll = ask(() => api().syncStatus({ login })).pipe(
      Effect.filterOrElse(
        (current) => current.state !== "unknown",
        () => ask(() => api().triggerSync({ login })),
      ),
      Effect.tap((current) =>
        Effect.sync(() => {
          setStatus(current);
          onProgress();
        }),
      ),
    );
    const fiber = Effect.runFork(
      poll.pipe(
        Effect.repeat({ schedule: Schedule.spaced(every), while: (current) => current.state === "queued" }),
        Effect.ignore,
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [login, onProgress, round]);

  const retry = () => {
    api()
      .triggerSync({ login })
      .then(setStatus, () => {})
      .finally(() => setRound((value) => value + 1));
  };

  return { status, retry };
}
