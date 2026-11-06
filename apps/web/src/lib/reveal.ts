import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { useEffect, useLayoutEffect, useState } from "react";
import { revealedKey } from "./reveal-script.ts";

const perCharacter = Duration.millis(20);
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

// Returns what the search tile shows while the query types itself, or undefined when the reveal is not playing.
export function useReveal(query: string, eligible: boolean) {
  const [typed, setTyped] = useState<string>();
  const [phase, setPhase] = useState<RevealPhase>("done");

  useLayoutEffect(() => {
    if (root().dataset.reveal !== "pending") return;
    // A tab opened in the background throttles timers to about one a second, so the query would crawl in.
    if (!eligible || document.visibilityState !== "visible") {
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
    if (phase !== "typing") return;
    const play = Effect.gen(function* () {
      for (let length = 1; length <= query.length; length++) {
        yield* Effect.sleep(perCharacter);
        setTyped(query.slice(0, length));
      }
      yield* Effect.sync(() => {
        delete root().dataset.reveal;
        emphasize();
        setTyped(undefined);
        setPhase("settled");
      });
      yield* Effect.sleep(Duration.millis(400));
      yield* Effect.sync(() => setPhase("done"));
    });
    const fiber = Effect.runFork(play);
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [phase, query]);

  const skip = () => {
    if (phase === "done") return;
    finish();
    setTyped(undefined);
    setPhase("done");
  };

  useEffect(() => {
    if (phase === "done") return;
    const hidden = () => {
      if (document.visibilityState === "hidden") skip();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  });

  return { typed, phase, skip };
}
