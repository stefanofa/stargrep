import type { AuthFailed } from "@stargrep/auth/auth";
import { GitHubTokens } from "@stargrep/auth/tokens";
import type { UserId } from "@stargrep/db/auth-schema";
import { GitHubTokenMissing, type Operation, RateLimited, type TokenBudgetExhausted } from "@stargrep/github/errors";
import * as FallbackGate from "@stargrep/github/fallback-gate";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { UserGitHubGate } from "./github-gate.ts";
import { inRuntime } from "./layers.ts";

export type JobGate = TokenGate.TokenGate["Service"] & {
  readonly defer: (error: RateLimited | TokenBudgetExhausted) => Effect.Effect<RateLimited | TokenBudgetExhausted>;
};

interface Job {
  readonly paidBy?: UserId | undefined;
  readonly sent?: Ref.Ref<number>;
}

export class UserGates extends Context.Service<
  UserGates,
  {
    readonly forJob: (job: Job) => Effect.Effect<JobGate, never, TokenGate.TokenGate>;
  }
>()("@stargrep/worker/user-gate/UserGates") {}

// Deferrals live for one invocation. A job that falls back consults the server's wait before sending another request.
const makeJobs = (userOf: (userId: UserId) => Effect.Effect<TokenGate.TokenGate["Service"] | undefined>) => {
  const deferred = new Map<string, RateLimited | TokenBudgetExhausted>();
  // A later request can fall back after an earlier reply hit the user's own limit.
  const limitedBy = new WeakMap<RateLimited | TokenBudgetExhausted, string>();
  const cached = (key: string, gate: TokenGate.TokenGate["Service"]) =>
    TokenGate.TokenGate.of({
      execute: Effect.fn("UserGates.cached")((operation, request) =>
        Effect.suspend(() => {
          const wait = deferred.get(key);
          return wait === undefined
            ? Effect.map(gate.execute(operation, request), (reply) => ({
                ...reply,
                onRateLimited: (failure: RateLimited) => {
                  limitedBy.set(failure, key);
                },
              }))
            : Effect.fail(wait);
        }).pipe(
          Effect.tapError((failure) =>
            failure._tag === "RateLimited" || failure._tag === "TokenBudgetExhausted"
              ? Effect.sync(() => {
                  limitedBy.set(failure, key);
                })
              : Effect.void,
          ),
        ),
      ),
    });
  return UserGates.of({
    forJob: Effect.fn("UserGates.forJob")(function* ({ paidBy, sent }: Job) {
      const server = yield* TokenGate.TokenGate;
      const counted = sent === undefined ? server : TokenGate.counting(server, sent);
      const serverGate = cached("server", counted);
      const user = paidBy === undefined ? undefined : yield* userOf(paidBy);
      const preferred =
        user === undefined || paidBy === undefined
          ? undefined
          : yield* FallbackGate.prefer(cached(`user/${paidBy}`, user), serverGate);
      const token =
        preferred === undefined
          ? Effect.succeed("server")
          : Effect.map(preferred.token, (token) => (token === "server" ? "server" : `user/${paidBy}`));
      return {
        execute: (preferred ?? serverGate).execute,
        defer: Effect.fn("UserGates.defer")(function* (error: RateLimited | TokenBudgetExhausted) {
          const key = limitedBy.get(error) ?? (yield* token);
          const known = deferred.get(key);
          if (known !== undefined) return known;
          const wait =
            error._tag === "RateLimited"
              ? new RateLimited({ ...error, deferredUntil: (yield* Clock.currentTimeMillis) + error.retryAfterMillis })
              : error;
          deferred.set(key, wait);
          return wait;
        }),
      } satisfies JobGate;
    }),
  });
};

export const layerServerOnly = Layer.sync(UserGates, () => makeJobs(() => Effect.undefined));

// A user's token is read once per invocation, at their first job's first GitHub request, so jobs of one user that run at
// once share one read and never refresh the same token twice. It never goes in a message or in storage.
export const layer = (gates: Effect.Success<typeof UserGitHubGate>) =>
  Layer.effect(
    UserGates,
    Effect.gen(function* () {
      const tokens = yield* GitHubTokens;
      const run = yield* inRuntime;
      const reads = new Map<UserId, Effect.Effect<Redacted.Redacted<string>, AuthFailed>>();
      const lock = yield* Semaphore.make(1);
      const tokenOf = (userId: UserId) =>
        Effect.flatten(
          lock.withPermit(
            Effect.gen(function* () {
              const known = reads.get(userId);
              if (known !== undefined) return known;
              const read = yield* Effect.cached(tokens.read(userId));
              reads.set(userId, read);
              return read;
            }),
          ),
        );
      return makeJobs(
        Effect.fn("UserGates.user")(function* (userId: UserId) {
          const stub = gates.getByName(userId);
          const remote = yield* Effect.cached(
            Effect.map(tokenOf(userId), (token) =>
              TokenGate.remote({
                execute: (sent) => run(stub.execute(sent, Redacted.value(token))),
              }),
            ),
          );
          return TokenGate.TokenGate.of({
            execute: Effect.fn("UserGitHubGate.execute")(function* (
              operation: Operation,
              request: HttpClientRequest.HttpClientRequest,
            ) {
              const gate = yield* remote.pipe(
                Effect.catchTag("AuthFailed", () => Effect.fail(new GitHubTokenMissing({ operation }))),
              );
              return yield* gate.execute(operation, request);
            }),
          });
        }),
      );
    }),
  );
