import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { GitHubRequestFailed, Operation } from "./errors.ts";
import * as RateLimit from "./rate-limit.ts";
import type { BudgetShare, RateLimit as Window } from "./schemas.ts";
import * as TokenBudget from "./token-budget.ts";
import * as TokenGate from "./token-gate.ts";

// GitHub names a window's reset in whole seconds, and a laptop's clock can run a little ahead of GitHub's, so a request
// that waits for a window to reset waits this long past it.
export const resetMargin = 2_000;

export interface State {
  readonly share: BudgetShare;
  readonly readers: number;
  readonly windows: Readonly<Record<string, Window>>;
  // Requests sent and not yet answered, by resource. GitHub has counted them, and no reply has said so yet.
  readonly sending: Readonly<Record<string, number>>;
  readonly pausedUntil: number;
}

export type Admission =
  | { readonly _tag: "Send" }
  | { readonly _tag: "Wait"; readonly until: number; readonly reason: "paused" | "share" };

export const initial = (share: BudgetShare, readers: number): State => ({
  share,
  readers,
  windows: {},
  sending: {},
  pausedUntil: 0,
});

// GitHub's remaining count at which the share of the window's limit is spent, so the operator's other tools keep the rest
// whenever the driver starts within the window.
const floorOf = (window: Window, share: BudgetShare) => window.limit - Math.floor(window.limit * share);

export const admit = (state: State, resource: string, now: number): readonly [Admission, State] => {
  if (now < state.pausedUntil) return [{ _tag: "Wait", until: state.pausedUntil, reason: "paused" }, state];
  const window = state.windows[resource];
  const sending = state.sending[resource] ?? 0;
  if (window !== undefined) {
    const opensAt = window.resetAt + resetMargin;
    if (now < opensAt && window.remaining - sending <= floorOf(window, state.share)) {
      return [{ _tag: "Wait", until: opensAt, reason: "share" }, state];
    }
  }
  return [{ _tag: "Send" }, { ...state, sending: { ...state.sending, [resource]: sending + 1 } }];
};

// Within one window GitHub's count only falls, and replies to concurrent requests can arrive out of order, so a reply
// never raises the count or brings back an older window.
const observe = (windows: State["windows"], reported: Window): State["windows"] => {
  const current = windows[reported.resource];
  if (current !== undefined && reported.resetAt < current.resetAt) return windows;
  const remaining =
    current !== undefined && current.resetAt === reported.resetAt
      ? Math.min(current.remaining, reported.remaining)
      : reported.remaining;
  return { ...windows, [reported.resource]: { ...reported, remaining } };
};

export interface Answer {
  readonly resource: string;
  readonly reported: Option.Option<Window>;
  // The wait a secondary rate limit named, which holds every request and costs one reader. A spent window needs no
  // pause, since its reported count already holds its own resource.
  readonly slowDown: Option.Option<number>;
}

export const settle = (state: State, answer: Answer, now: number): State => {
  const sending = { ...state.sending, [answer.resource]: (state.sending[answer.resource] ?? 0) - 1 };
  const windows = Option.match(answer.reported, {
    onNone: () => state.windows,
    onSome: (reported) => observe(state.windows, reported),
  });
  if (Option.isNone(answer.slowDown)) return { ...state, sending, windows };
  // Replies to requests sent before the pause began belong to the same slowdown and cost no further reader.
  const fresh = now >= state.pausedUntil;
  return {
    ...state,
    sending,
    windows,
    pausedUntil: Math.max(state.pausedUntil, now + answer.slowDown.value),
    readers: fresh ? Math.max(state.readers - 1, 1) : state.readers,
  };
};

const answerOf = (resource: string, path: string, exit: Exit.Exit<TokenGate.Reply, GitHubRequestFailed>, now: number) =>
  Exit.match(exit, {
    onFailure: (): Answer => ({ resource, reported: Option.none(), slowDown: Option.none() }),
    onSuccess: (reply): Answer => {
      const meaning = RateLimit.classify(reply, now, path);
      return {
        resource,
        reported: Option.all({
          resource: Option.orElse(reply.rateLimit.resource, () => Option.some(resource)),
          limit: reply.rateLimit.limit,
          remaining: reply.rateLimit.remaining,
          resetAt: reply.rateLimit.resetAt,
        }),
        slowDown:
          meaning._tag === "RateLimited" && !meaning.windowSpent
            ? Option.some(meaning.retryAfterMillis)
            : Option.none(),
      };
    },
  });

export interface Options {
  readonly token: Redacted.Redacted<string>;
  readonly share: BudgetShare;
  readonly readers: number;
}

// A gate for one bulk driver on a developer's machine, such as the star import, which reads several accounts at once on
// a personal token. It sends up to `readers` requests at once and never spends past `share` of a window's limit. A
// request that would waits for the window to reset instead of failing, so a driver keeps its place in a read. A
// secondary rate limit pauses every request and takes one reader away for the rest of the run.
export const make = Effect.fn("BulkGate.make")(function* (options: Options) {
  const client = yield* HttpClient.HttpClient;
  const permits = yield* Semaphore.make(options.readers);
  const state = yield* Ref.make(initial(options.share, options.readers));

  const enter = Effect.fnUntraced(function* (resource: string) {
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      const admission = yield* Ref.modify(state, (current) => admit(current, resource, now));
      if (admission._tag === "Send") return;
      yield* Effect.logInfo(
        admission.reason === "share"
          ? "GitHub token share spent, waiting for the window to reset"
          : "GitHub asked to slow down, waiting",
        { resource, seconds: Math.ceil((admission.until - now) / 1000) },
      );
      yield* Effect.interruptible(Effect.sleep(Duration.millis(admission.until - now)));
    }
  });

  const leave = Effect.fnUntraced(function* (
    resource: string,
    path: string,
    exit: Exit.Exit<TokenGate.Reply, GitHubRequestFailed>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const answer = answerOf(resource, path, exit, now);
    const [before, after] = yield* Ref.modify(state, (current) => {
      const next = settle(current, answer, now);
      return [[current, next] as const, next];
    });
    if (after.readers !== before.readers) yield* permits.resize(after.readers);
    if (after.pausedUntil > before.pausedUntil) {
      yield* Effect.logWarning("GitHub sent a secondary rate limit, so every request pauses", {
        seconds: Math.ceil((after.pausedUntil - now) / 1000),
        readers: after.readers,
      });
    }
  });

  return TokenGate.TokenGate.of({
    execute: Effect.fn("TokenGate.execute")(function* (
      operation: Operation,
      request: HttpClientRequest.HttpClientRequest,
    ) {
      const endpoint = TokenGate.endpointOf(operation, request);
      yield* Effect.annotateCurrentSpan({ "http.request.method": endpoint.method, "url.path": endpoint.path });
      const resource = TokenBudget.resourceOf(endpoint.path);
      const reply = yield* Effect.acquireUseRelease(
        enter(resource),
        () => TokenGate.send(client, endpoint, HttpClientRequest.bearerToken(request, options.token)),
        (_, exit) => leave(resource, endpoint.path, exit),
      );
      yield* Effect.annotateCurrentSpan({ "http.response.status_code": reply.status });
      return reply;
    }, permits.withPermit),
  });
});

export const layer = (options: Options) => Layer.effect(TokenGate.TokenGate, make(options));
