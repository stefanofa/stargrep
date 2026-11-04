import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

// A fresh stage settles within about a minute, so its waits retry once a second for up to that long.
const freshStageWait = Duration.seconds(60);
const freshStageSchedule = Schedule.max([Schedule.spaced("1 second"), Schedule.during(freshStageWait)]);
const requestTimeout = Duration.seconds(30);

export class NotSettled extends Schema.TaggedError<NotSettled>()("NotSettled", { answer: Schema.String }) {}
const isNotSettled = Schema.is(NotSettled);

// The retry window opens at the first failure and a slow attempt can outlast it, so the whole wait has one deadline.
const untilSettled = <A, E extends { readonly _tag: string }, R>(
  attempt: Effect.Effect<A, E | NotSettled, R>,
  gaveUp: (lastAnswer: string) => string,
) =>
  Effect.suspend(() => {
    let lastAnswer = "none";
    const die = () => Effect.die(new Error(gaveUp(lastAnswer)));
    return attempt.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (isNotSettled(error)) lastAnswer = error.answer;
        }),
      ),
      Effect.retry({ while: isNotSettled, schedule: freshStageSchedule }),
      Effect.catchTag("NotSettled", die),
      Effect.timeoutOrElse({ duration: freshStageWait, orElse: die }),
    );
  });

export const waitUntilReady = <R>(url: string, check: Effect.Effect<void, NotSettled, R>) =>
  untilSettled(
    check,
    (lastAnswer) => `${url} was not ready within ${Duration.toSeconds(freshStageWait)} s, last answer: ${lastAnswer}`,
  );

export type Answer = { readonly status: number; readonly contentType: string; readonly body: string };
export type Resends = { cloudflare404: number; dropped: number };

// Until a new workers.dev URL reaches every edge machine, some requests get Cloudflare's own HTML 404 page instead of
// the Worker, for over a minute under load. The Worker never answers with HTML, so those requests are sent again.
const isCloudflare404 = (answer: Answer) => answer.status === 404 && answer.contentType.startsWith("text/html");

// A connection can also drop before any answer arrives, which leaves no status to judge, so that call is sent once more.
// Every HTTP answer is judged as it is.
export const untilRouted = <R>(
  what: string,
  send: Effect.Effect<Answer, HttpClientError.HttpClientError, R>,
  resends: Resends,
) =>
  Effect.suspend(() => {
    let dropped = false;
    const attempt = send.pipe(
      Effect.timeoutOrElse({
        duration: requestTimeout,
        orElse: () => Effect.die(new Error(`${what} sent no answer within ${Duration.toSeconds(requestTimeout)} s`)),
      }),
      Effect.catchIf(
        (error) => error.reason._tag === "TransportError" && !dropped,
        (error) =>
          Effect.sync(() => {
            dropped = true;
            resends.dropped++;
          }).pipe(
            Effect.andThen(Effect.fail(new NotSettled({ answer: `dropped before any answer: ${error.message}` }))),
          ),
      ),
      Effect.filterOrFail(
        (answer) => !isCloudflare404(answer),
        () => {
          resends.cloudflare404++;
          return new NotSettled({ answer: "Cloudflare's 404 page" });
        },
      ),
    );
    return untilSettled(
      attempt,
      (lastAnswer) =>
        `${what} did not reach the Worker within ${Duration.toSeconds(freshStageWait)} s, last answer: ${lastAnswer}`,
    );
  });
