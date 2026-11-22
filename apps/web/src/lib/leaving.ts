import { useEffect, useRef, useState } from "react";
import { unfollow } from "./follows.ts";
import { after } from "./wall-clock.ts";

// How long an unfollowed row offers undo.
export const undoWindow = 5_000;

// The rows unfollowed on the people-you-follow page whose undo window is still open. Each unfollow waits for its window
// to close, so undo only cancels it and nothing reaches the API. A saved unfollow calls onLeft, and one that fails puts
// the row back at once, with the store's refusal to show. Leaving the page saves every waiting unfollow then.
export const useLeaving = (onLeft: (login: string) => void, window = undoWindow) => {
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const waiting = useRef(new Map<string, { readonly cancel: () => void; readonly save: () => void }>());
  const left = useRef(onLeft);
  left.current = onLeft;

  const settle = (login: string) => {
    waiting.current.delete(login);
    setLeaving((current) => {
      const next = new Set(current);
      next.delete(login);
      return next;
    });
  };

  const save = (login: string) => {
    settle(login);
    void unfollow(login).then((saved) => {
      if (saved) left.current(login);
    });
  };

  useEffect(
    () => () => {
      for (const [login, waits] of waiting.current) {
        waits.cancel();
        void unfollow(login);
      }
    },
    [],
  );

  return {
    leaving,
    leave: (login: string) => {
      if (waiting.current.has(login)) return;
      const cancel = after(window, () => save(login));
      waiting.current.set(login, { cancel, save: () => save(login) });
      setLeaving((current) => new Set(current).add(login));
    },
    undo: (login: string) => {
      waiting.current.get(login)?.cancel();
      settle(login);
    },
  };
};
