import type { UserId } from "@stargrep/db/auth-schema";
import * as AuthSchema from "@stargrep/db/auth-schema";
import { acquirePool } from "@stargrep/db/node-postgres";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { type AuthFailed, providerId, readGitHubToken } from "./auth.ts";
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
  const auth = betterAuth({
    appName: "Stargrep",
    secret: Redacted.value(config.secret),
    database,
    socialProviders: {
      [providerId]: {
        clientId: config.clientId,
        ...Option.match(config.clientSecret, {
          onNone: () => ({}),
          onSome: (secret) => ({ clientSecret: Redacted.value(secret) }),
        }),
      },
    },
    account: { encryptOAuthTokens: true },
    telemetry: { enabled: false },
    logger: { level: "error" },
  });
  return GitHubTokens.of({ read: Effect.fn("GitHubTokens.read")((userId: UserId) => readGitHubToken(auth, userId)) });
};

// Each read opens one connection and closes it before it returns, so a consumer holds no socket for it while it works.
export const layer = <R>(config: TokenConfig, connectionString: Effect.Effect<Redacted.Redacted<string>, never, R>) =>
  Layer.effect(
    GitHubTokens,
    Effect.map(Effect.context<R>(), (context) =>
      GitHubTokens.of({
        read: Effect.fn("GitHubTokens.open")(
          function* (userId: UserId) {
            const pool = yield* acquirePool(Redacted.value(yield* connectionString), 1);
            const database = drizzleAdapter(drizzle({ client: pool }), { provider: "pg", schema: AuthSchema });
            return yield* make(database, config).read(userId);
          },
          Effect.scoped,
          Effect.provideContext(context),
        ),
      }),
    ),
  );
