import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
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

export const waitUntilConsumed = <E extends { readonly _tag: string }, R>(
  expected: ReadonlyArray<string>,
  read: Effect.Effect<ReadonlyArray<string>, E, R>,
) =>
  untilSettled(
    read.pipe(
      Effect.filterOrFail(
        (consumed) => expected.every((id) => consumed.includes(id)),
        (consumed) => {
          const missing = expected.filter((id) => !consumed.includes(id));
          return new NotSettled({
            answer: `${expected.length - missing.length}/${expected.length} consumed; missing: ${missing.join(", ")}`,
          });
        },
      ),
    ),
    (lastAnswer) =>
      `Queue consumption did not finish within ${Duration.toSeconds(freshStageWait)} s, last answer: ${lastAnswer}`,
  );

export type Answer = {
  readonly status: number;
  readonly placement: string | undefined;
  readonly body: string;
};

export const readAnswer = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      Effect.map(
        response.text,
        (body): Answer => ({
          status: response.status,
          placement: response.headers["cf-placement"],
          body,
        }),
      ),
    ),
  );

// A new Worker reaches Cloudflare's machines one by one. For about a minute after a deploy creates it, a call can reach
// a machine that answers for the Worker without running it, and the next call can reach one that runs it. New stages
// got these answers that way, in CI and from a probe. They say nothing about the Worker, so the call is sent again.
const unrouted = [
  // The machine has not loaded the Worker behind the custom domain. Cloudflare sends the page as HTML or as plain text,
  // depending on the client.
  {
    kind: "scriptNotFound",
    answer: "Cloudflare's Script not found page",
    matches: ({ status, body }: Answer) =>
      status === 500 &&
      (body.includes('<span class="cf-error-code">1104</span>') || body.trim() === "error code: 1104"),
  },
  // Placement sent the call on to the region near the database, which had not loaded the Worker. The web Worker
  // answers its own errors with a body. The main Worker answers a defect with an empty 500, but a defect repeats on
  // every resend, so the call still fails.
  {
    kind: "placement",
    answer: "an empty 500 from the placement region",
    matches: ({ status, body, placement }: Answer) => status === 500 && body === "" && placement !== undefined,
  },
] as const;

export type Resends = Record<(typeof unrouted)[number]["kind"] | "dropped", number>;

// In CI, a run of the old 1000-call smoke burst lost a single call to ECONNRESET between the runner and Cloudflare,
// before any answer arrived. A reset carries no status to judge and each run lost only one call, so the call is sent
// once more. A second drop of the same call fails the run, because a path that keeps dropping is a real fault.
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
      Effect.flatMap((answer) => {
        const found = unrouted.find(({ matches }) => matches(answer));
        if (found === undefined) return Effect.succeed(answer);
        resends[found.kind]++;
        return Effect.fail(new NotSettled({ answer: found.answer }));
      }),
    );
    return untilSettled(
      attempt,
      (lastAnswer) =>
        `${what} did not reach the Worker within ${Duration.toSeconds(freshStageWait)} s, last answer: ${lastAnswer}`,
    );
  });
