import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

// A fresh stage settles within about a minute, so its waits retry once a second for up to that long.
export const freshStageWait = Duration.seconds(60);
export const freshStageSchedule = Schedule.max([Schedule.spaced("1 second"), Schedule.during(freshStageWait)]);

export class NotReady extends Schema.TaggedError<NotReady>()("NotReady", { answer: Schema.String }) {}

// The retry window opens at the first failure and a slow last check can outlast it, so the whole wait has one deadline.
export const waitUntilReady = <R>(url: string, check: Effect.Effect<void, NotReady, R>) =>
  Effect.suspend(() => {
    let lastAnswer = "none";
    const notReady = () =>
      Effect.die(
        new Error(`${url} was not ready within ${Duration.toSeconds(freshStageWait)} s, last answer: ${lastAnswer}`),
      );
    return check.pipe(
      Effect.tapError((error) => Effect.sync(() => (lastAnswer = error.answer))),
      Effect.retry({ schedule: freshStageSchedule }),
      Effect.catchTag("NotReady", notReady),
      Effect.timeoutOrElse({ duration: freshStageWait, orElse: notReady }),
    );
  });
