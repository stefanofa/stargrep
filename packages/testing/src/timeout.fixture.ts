import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { layer, live } from "./index.ts";

// Wall-clock waits: a layer builds on the TestClock, and these must outlast
// the 50ms test timeout for real.
const wait = (ms: number) => Effect.promise(() => Bun.sleep(ms));

let released = false;
const SlowBuild = Layer.effectDiscard(
  Effect.acquireRelease(Effect.void, () =>
    Effect.sync(() => {
      released = true;
    }),
  ).pipe(
    Effect.andThen(wait(100)),
    // The layer runs on TestConsole, so write past it.
    Effect.andThen(Effect.sync(() => process.stdout.write(released ? "build:after-release\n" : "build:done\n"))),
  ),
);

layer(SlowBuild, { timeout: 50 })("builds past its timeout", (it) => {
  it.effect("never runs", () => Effect.void);
});

live("hangs past its timeout", () =>
  Effect.acquireRelease(Effect.void, (_, exit) =>
    Console.log(
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? "released:interrupted" : "released:other",
    ),
  ).pipe(Effect.andThen(Effect.never)),
);

live("hangs past its timeout, then its finalizer fails", () =>
  Effect.acquireRelease(Effect.void, () => Effect.die(new Error("finalizer broke after timeout"))).pipe(
    Effect.andThen(Effect.never),
  ),
);

live("hangs past its timeout, then its finalizer outlasts the timeout", () =>
  Effect.acquireRelease(Effect.void, () => wait(200).pipe(Effect.andThen(Console.log("released:slow")))).pipe(
    Effect.andThen(Effect.never),
  ),
);

live("starts after the slow finalizer", () => Console.log("next:started"));
