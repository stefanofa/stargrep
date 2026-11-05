import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";
import { api, type SyncStatus } from "./rpc.ts";

const importing = Duration.seconds(2);
const reading = Duration.seconds(5);

const stillReading = ({ enrichment }: SyncStatus) => enrichment.read + enrichment.failed < enrichment.total;

const readCount = (status: SyncStatus | undefined) => status?.enrichment.read;

const idle = Duration.seconds(30);

const busy = (status: SyncStatus | undefined) =>
  status !== undefined && (status.state === "queued" || stillReading(status));

export function useSync(login: string, onProgress: () => void) {
  const [status, setStatus] = useState<SyncStatus>();
  const [round, setRound] = useState(0);
  const [wake, setWake] = useState(0);
  const previous = useRef<SyncStatus>(undefined);
  const triggered = useRef(0);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setWake((value) => value + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

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
        const before = previous.current;
        setStatus(current);
        const syncing = before?.state === "queued" || current.state === "queued";
        const readMore = before !== undefined && readCount(current) !== readCount(before);
        if (syncing || readMore) onProgress();
        previous.current = current;
        return current;
      });
    const step = (ask: typeof read) => ask.pipe(Effect.flatMap(publish), Effect.option);
    const first = round > triggered.current ? trigger : read;
    triggered.current = round;
    const poll = Effect.gen(function* () {
      let current = Option.getOrUndefined(yield* step(first));
      while (true) {
        yield* Effect.sleep(current?.state === "queued" ? importing : busy(current) ? reading : idle);
        if (!busy(current) && document.visibilityState === "hidden") continue;
        current = Option.getOrElse(yield* step(read), () => current);
      }
    });
    const fiber = Effect.runFork(poll);
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [login, onProgress, round, wake]);

  return { status, retry: () => setRound((value) => value + 1) };
}
