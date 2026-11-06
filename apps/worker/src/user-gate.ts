import type { AuthFailed } from "@stargrep/auth/auth";
import { GitHubTokens } from "@stargrep/auth/tokens";
import type { UserId } from "@stargrep/db/auth-schema";
import { GitHubTokenMissing, type Operation } from "@stargrep/github/errors";
import * as FallbackGate from "@stargrep/github/fallback-gate";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import type { UserGitHubGate } from "./github-gate.ts";
import { inRuntime } from "./layers.ts";

export class UserGates extends Context.Service<
  UserGates,
  {
    // The gate for one job: the server's for work no signed-in user started, else the user's token while it works and
    // their share lasts, then the server's.
    readonly gate: (
      paidBy: UserId | undefined,
      server: TokenGate.TokenGate["Service"],
    ) => Effect.Effect<TokenGate.TokenGate["Service"]>;
  }
>()("@stargrep/worker/user-gate/UserGates") {}

// A stage without sign-in has no user tokens, so every job runs on the server's token.
export const layerServerOnly = Layer.succeed(
  UserGates,
  UserGates.of({
    gate: Effect.fn("UserGates.gate")((_paidBy: UserId | undefined, server: TokenGate.TokenGate["Service"]) =>
      Effect.succeed(server),
    ),
  }),
);

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
      return UserGates.of({
        gate: Effect.fn("UserGates.gate")(function* (
          paidBy: UserId | undefined,
          server: TokenGate.TokenGate["Service"],
        ) {
          if (paidBy === undefined) return server;
          const userId = paidBy;
          const token = tokenOf(userId);
          const user = TokenGate.TokenGate.of({
            execute: Effect.fn("UserGitHubGate.execute")(function* (
              operation: Operation,
              request: HttpClientRequest.HttpClientRequest,
            ) {
              const value = yield* token.pipe(
                Effect.catchTag("AuthFailed", () => Effect.fail(new GitHubTokenMissing({ operation }))),
              );
              const remote = TokenGate.remote({
                execute: (sent) => run(gates.getByName(userId).execute(sent, Redacted.value(value))),
              });
              return yield* remote.execute(operation, request);
            }),
          });
          return yield* FallbackGate.prefer(user, server);
        }),
      });
    }),
  );
