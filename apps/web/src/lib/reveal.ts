import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { useEffect, useLayoutEffect, useState } from "react";
import { revealedKey } from "./reveal-script.ts";
import { playReveal } from "./reveal-timing.ts";

const ease = "cubic-bezier(0.2, 0, 0, 1)";
const lifted = 6;

export type RevealPhase = "typing" | "settled" | "done";

const root = () => document.documentElement;

let playing: Array<Animation> = [];

// The rows are on screen the whole time. Once the query has typed itself they lift 3px into place, each starting from
// where it already is, in under 200ms, and nothing waits for it.
const emphasize = () => {
  const rows = Array.from(document.querySelectorAll("[data-reveal-results] li")).slice(0, lifted);
  playing = rows.map((row, index) =>
    row.animate([{ translate: "0 3px" }, { translate: "0 0" }], { duration: 160, delay: index * 30, easing: ease }),
  );
};

const finish = () => {
  delete root().dataset.reveal;
  for (const animation of playing) animation.finish();
  playing = [];
};

const interactions = ["keydown", "pointerdown", "focusin"] as const;

// Returns what the search tile shows while the query types itself, or undefined when the reveal is not playing.
export function useReveal(query: string, eligible: boolean) {
  const [typed, setTyped] = useState<string>();
  const [phase, setPhase] = useState<RevealPhase>("done");
  const running = phase !== "done";

  useLayoutEffect(() => {
    if (root().dataset.reveal !== "pending") return;
    // A tab opened in the background throttles timers to about one a second, so the query would crawl in. A visitor
    // already in a field is typing, and the reveal would type over them.
    const typing = document.activeElement instanceof HTMLInputElement;
    if (!eligible || typing || document.visibilityState !== "visible") {
      delete root().dataset.reveal;
      return;
    }
    try {
      sessionStorage.setItem(revealedKey, "1");
    } catch {}
    root().dataset.reveal = "typing";
    setTyped("");
    setPhase("typing");
  }, [eligible]);

  useEffect(() => {
    if (!running) return;
    const play = playReveal(query, {
      typed: setTyped,
      settled: () => {
        delete root().dataset.reveal;
        emphasize();
        setTyped(undefined);
        setPhase("settled");
      },
      done: () => setPhase("done"),
    });
    const fiber = Effect.runFork(play);
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [running, query]);

  // Any key, click or focus on the page jumps to the end, and so does leaving the tab.
  useEffect(() => {
    if (phase === "done") return;
    const skip = () => {
      finish();
      setTyped(undefined);
      setPhase("done");
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") skip();
    };
    for (const name of interactions) document.addEventListener(name, skip, { capture: true });
    document.addEventListener("visibilitychange", hidden);
    return () => {
      for (const name of interactions) document.removeEventListener(name, skip, { capture: true });
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [phase]);

  return { typed, phase };
}
