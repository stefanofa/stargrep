import { RateLimited, TokenBudgetExhausted } from "@stargrep/github/errors";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

const isLimit = Schema.is(Schema.Union([TokenBudgetExhausted, RateLimited]));

// GitHub names when a spent budget or a rate limit lifts, and a bulk driver on a developer's machine waits for it rather
// than give up its work. Any other failure passes through.
export const waitForGitHub = <E>(driver: string) => ({
  schedule: Schedule.spaced(Duration.seconds(1)).pipe(
    Schedule.setInputType<E>(),
    Schedule.modifyDelay(({ duration, input }) => {
      if (!isLimit(input)) return Effect.succeed(duration);
      return Effect.map(Clock.currentTimeMillis, (now) =>
        Duration.millis(
          Math.max(input._tag === "TokenBudgetExhausted" ? input.resetAt - now : input.retryAfterMillis, 1_000),
        ),
      ).pipe(
        Effect.tap((delay) =>
          Effect.logInfo(`${driver} waits for GitHub's limit to lift`, {
            resource: input.resource,
            seconds: Math.ceil(Duration.toSeconds(delay)),
          }),
        ),
      );
    }),
  ),
  times: 12,
  while: isLimit,
});
