import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { live } from "./index.ts";

live(
  "hangs past its timeout",
  () =>
    Effect.acquireRelease(Effect.void, (_, exit) =>
      Console.log(
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? "released:interrupted" : "released:other",
      ),
    ).pipe(Effect.andThen(Effect.never)),
  50,
);

live(
  "hangs past its timeout, then its finalizer fails",
  () =>
    Effect.acquireRelease(Effect.void, () => Effect.die(new Error("finalizer broke after timeout"))).pipe(
      Effect.andThen(Effect.never),
    ),
  50,
);
