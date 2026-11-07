import type { UserId } from "@stargrep/db/auth-schema";
import * as AuthSchema from "@stargrep/db/auth-schema";
import { acquirePool } from "@stargrep/db/node-postgres";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AuthFailed, baseOptions, readGitHubToken, tokenReadTimeout } from "./auth.ts";
import type { TokenConfig } from "./config.ts";

// Reads a signed-in user's GitHub token where no request carries their session, such as a queue consumer running work
// the user started.
export class GitHubTokens extends Context.Service<
  GitHubTokens,
  {
    readonly read: (userId: UserId) => Effect.Effect<Redacted.Redacted<string>, AuthFailed>;
  }
>()("@stargrep/auth/tokens/GitHubTokens") {}

// Only the GitHub provider and token encryption, with no routes, sessions, or plugins.
export const make = (database: BetterAuthOptions["database"], config: TokenConfig) => {
  const auth = betterAuth(baseOptions(database, config));
  return GitHubTokens.of({ read: Effect.fn("GitHubTokens.read")((userId: UserId) => readGitHubToken(auth, userId)) });
};

// A read that times out returns at once and closes its connection in the background, because closing waits for the
// query the timeout gave up on.
export const bounded = Effect.fnUntraced(function* <A>(read: Effect.Effect<A, AuthFailed>) {
  const fiber = yield* Effect.forkDetach(read);
  return yield* Fiber.join(fiber).pipe(
    Effect.timeoutOrElse({
      duration: tokenReadTimeout,
      orElse: () =>
        Effect.andThen(
          Effect.forkDetach(Fiber.interrupt(fiber)),
          Effect.fail(new AuthFailed({ operation: "token", cause: "Reading the GitHub token timed out" })),
        ),
    }),
  );
});

// Each read opens one connection and closes it before it returns, so a consumer holds no socket for it while it works.
export const layer = <R>(config: TokenConfig, connectionString: Effect.Effect<Redacted.Redacted<string>, never, R>) =>
  Layer.effect(
    GitHubTokens,
    Effect.map(Effect.context<R>(), (context) =>
      GitHubTokens.of({
        read: Effect.fn("GitHubTokens.open")(function* (userId: UserId) {
          const read = Effect.gen(function* () {
            const pool = yield* acquirePool(Redacted.value(yield* connectionString), 1);
            const database = drizzleAdapter(drizzle({ client: pool }), { provider: "pg", schema: AuthSchema });
            return yield* make(database, config).read(userId);
          });
          return yield* bounded(read.pipe(Effect.scoped, Effect.provideContext(context)));
        }),
      }),
    ),
  );
