import * as Effect from "effect/Effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import type { Operation } from "./errors.ts";
import { BudgetShare } from "./schemas.ts";
import * as TokenGate from "./token-gate.ts";

// A user's 5,000 REST requests an hour also serve their own tools, such as the gh CLI and CI. Stargrep takes a fifth of
// what remained when each window opened. A full sync of 3,000 stars needs about 33 requests, and work past the share,
// such as the README reads of a large first import, falls back to the server's token.
export const userShare = BudgetShare.make(0.2);

export type FallbackReason = "budget" | "unauthorized" | "rate-limited" | "token-unavailable";

export const fallbacks = Metric.counter("stargrep_github_fallbacks", {
  description:
    "Jobs a user started that moved to the server's GitHub token, by reason: budget, unauthorized, rate-limited, token-unavailable.",
});

// A 401 means the token expired or the user revoked it. A rate limit with nothing remaining means the user's own tools
// spent the window. A secondary rate limit keeps quota, so the GitHub client waits it out on the same token.
const replyReason = (reply: TokenGate.Reply): Option.Option<FallbackReason> => {
  if (reply.status === 401) return Option.some("unauthorized");
  if ((reply.status === 403 || reply.status === 429) && Option.contains(reply.rateLimit.remaining, 0)) {
    return Option.some("rate-limited");
  }
  return Option.none();
};

const logFallback = (reason: FallbackReason, operation: Operation) => {
  const fields = { reason, operation };
  return Effect.all([
    reason === "budget"
      ? Effect.logInfo("A user's job moved to the server's GitHub token", fields)
      : Effect.logWarning("A user's job moved to the server's GitHub token", fields),
    Metric.update(Metric.withAttributes(fallbacks, { reason }), 1),
  ]);
};

// One job's gate: the user's token until the first reason to stop, then the server's token for the rest of the job. So a
// revoked token costs one request and a spent share none.
export const prefer = Effect.fn("FallbackGate.prefer")(function* (
  user: TokenGate.TokenGate["Service"],
  server: TokenGate.TokenGate["Service"],
) {
  const movedToServer = yield* Ref.make(false);

  const fallBack = Effect.fnUntraced(function* (
    reason: FallbackReason,
    operation: Operation,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    if (!(yield* Ref.getAndSet(movedToServer, true))) yield* logFallback(reason, operation);
    return yield* server.execute(operation, request);
  });

  const execute = Effect.fn("TokenGate.prefer")(function* (
    operation: Operation,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    if (yield* Ref.get(movedToServer)) return yield* server.execute(operation, request);
    const sent = yield* Effect.result(user.execute(operation, request));
    if (Result.isFailure(sent)) {
      switch (sent.failure._tag) {
        case "TokenBudgetExhausted":
          return yield* fallBack("budget", operation, request);
        case "GitHubTokenMissing":
          return yield* fallBack("token-unavailable", operation, request);
        case "GitHubRequestFailed":
          return yield* sent.failure;
      }
    }
    const reason = replyReason(sent.success);
    return Option.isSome(reason) ? yield* fallBack(reason.value, operation, request) : sent.success;
  });

  return TokenGate.TokenGate.of({ execute });
});
