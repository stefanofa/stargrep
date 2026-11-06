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
import type { UserGitHubGate } from "./github-gate.ts";
import { inRuntime } from "./layers.ts";

export class UserGates extends Context.Service<
  UserGates,
  {
    // The gate for one job a signed-in user started: their token while it works and their share lasts, then the server's.
    readonly gate: (
      userId: UserId,
      server: TokenGate.TokenGate["Service"],
    ) => Effect.Effect<TokenGate.TokenGate["Service"]>;
  }
>()("@stargrep/worker/user-gate/UserGates") {}

// A stage without sign-in has no user tokens, so every job runs on the server's token.
export const layerServerOnly = Layer.succeed(
  UserGates,
  UserGates.of({
    gate: Effect.fn("UserGates.gate")((_userId: UserId, server: TokenGate.TokenGate["Service"]) =>
      Effect.succeed(server),
    ),
  }),
);

// A job reads the user's token once, at its first GitHub request, and never puts it in a message or in storage.
export const layer = (gates: Effect.Success<typeof UserGitHubGate>) =>
  Layer.effect(
    UserGates,
    Effect.gen(function* () {
      const tokens = yield* GitHubTokens;
      const run = yield* inRuntime;
      return UserGates.of({
        gate: Effect.fn("UserGates.gate")(function* (userId: UserId, server: TokenGate.TokenGate["Service"]) {
          const token = yield* Effect.cached(tokens.read(userId));
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
