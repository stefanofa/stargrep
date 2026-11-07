import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export const playReveal = Effect.fn("Reveal.play")(function* (
  query: string,
  events: {
    readonly typed: (text: string) => void;
    readonly settled: () => void;
    readonly done: () => void;
  },
) {
  for (let length = 1; length <= query.length; length++) {
    yield* Effect.sleep(Duration.millis(20));
    yield* Effect.sync(() => events.typed(query.slice(0, length)));
  }
  yield* Effect.sync(events.settled);
  yield* Effect.sleep(Duration.millis(400));
  yield* Effect.sync(events.done);
});

export const playSurprise = (wait: number, changed: (surprised: boolean) => void) =>
  Effect.sleep(Duration.millis(wait)).pipe(
    Effect.andThen(Effect.sync(() => changed(true))),
    Effect.andThen(Effect.sleep(Duration.millis(1200))),
    Effect.ensuring(Effect.sync(() => changed(false))),
  );
