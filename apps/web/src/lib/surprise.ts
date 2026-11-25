import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

// Pip looks surprised for a moment once results by meaning land after a quiet spell.
export const playSurprise = (wait: number, changed: (surprised: boolean) => void) =>
  Effect.sleep(Duration.millis(wait)).pipe(
    Effect.andThen(Effect.sync(() => changed(true))),
    Effect.andThen(Effect.sleep(Duration.millis(1200))),
    Effect.ensuring(Effect.sync(() => changed(false))),
  );
