import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { useEffect, useEffectEvent, useState } from "react";
import { api, type SyncStatus } from "./rpc.ts";
import { SyncFailed, SyncRefused, type SyncWatch, watchSync } from "./sync-watch.ts";
import { forgetRefusal, type Refusal, refusalOf, rememberRefusal } from "./trouble.ts";

const visible = Effect.callback<void>((resume) => {
  const onChange = () => {
    if (document.visibilityState === "visible") resume(Effect.void);
  };
  document.addEventListener("visibilitychange", onChange);
  return Effect.sync(() => document.removeEventListener("visibilitychange", onChange));
});

const whenVisible = Effect.suspend(() => (document.visibilityState === "visible" ? Effect.void : visible));

// Rendering a page never starts an import, since crawlers and link previews render pages too. The browser asks once the
// page is hydrated and its tab is visible. A refusal, from this page or remembered from an earlier load, stays on screen
// until the visitor tries again, so the page never asks twice on its own.
export function useSync(login: string, onProgress: () => void, initial?: SyncStatus, refused?: Refusal) {
  const [watch, setWatch] = useState<SyncWatch>(
    refused === undefined ? { kind: "watching", status: initial, at: undefined } : { kind: refused },
  );
  const [round, setRound] = useState(0);
  const progressed = useEffectEvent(onProgress);

  useEffect(() => {
    if (round === 0 && refused !== undefined) return;
    const client = api();
    const trigger = Effect.tryPromise({
      try: () => client.triggerSync({ login }),
      catch: (cause) => new SyncRefused({ refusal: refusalOf(cause) }),
    }).pipe(Effect.tap(() => Effect.sync(() => forgetRefusal(login))));
    const read = Effect.tryPromise({
      try: () => client.syncStatus({ login }),
      catch: (cause) => new SyncFailed({ cause }),
    });
    const poll = watchSync({
      initial,
      retry: round !== 0,
      read,
      trigger,
      visible,
      whenVisible,
      changed: setWatch,
      progressed,
      refused: (refusal) => rememberRefusal(login, refusal),
    });
    const fiber = Effect.runFork(poll);
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [login, round, initial, refused]);

  return { watch, retry: () => setRound((value) => value + 1) };
}
