import * as AuthSchema from "@stargrep/db/auth-schema";
import { UserId } from "@stargrep/db/auth-schema";
import { acquirePool } from "@stargrep/db/node-postgres";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { refreshAccessToken } from "better-auth/oauth2";
import { oAuthProxy } from "better-auth/plugins/oauth-proxy";
import { drizzle } from "drizzle-orm/node-postgres";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type pg from "pg";
import { type AuthConfig, basePath, type TokenConfig } from "./config.ts";

export const providerId = "github";

const tokenEndpoint = "https://github.com/login/oauth/access_token";

// GitHub refuses a used or revoked refresh token with a 200 that names an error, and Better Auth would then store the
// refresh token it read over the one a concurrent refresh just wrote. A refresh with no access token fails before Better
// Auth writes anything, so the newest refresh token stays.
export const githubProvider = (clientId: string, clientSecret?: string) => ({
  clientId,
  ...(clientSecret === undefined ? {} : { clientSecret }),
  refreshAccessToken: async (refreshToken: string) => {
    const tokens = await refreshAccessToken({ refreshToken, options: { clientId, clientSecret }, tokenEndpoint });
    if (!tokens.accessToken) throw new Error("GitHub refused the refresh token");
    return tokens;
  },
});

export const redirectAllowed = (location: string, origin: string, previewHost?: RegExp) => {
  const target = URL.parse(location, origin);
  return (
    target !== null &&
    (target.origin === origin ||
      (target.protocol === "https:" && target.port === "" && previewHost?.test(target.hostname) === true))
  );
};

export class AuthFailed extends Schema.TaggedError<AuthFailed, { readonly brand: unique symbol }>()("AuthFailed", {
  operation: Schema.Literals(["handle", "session", "token"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Auth '${this.operation}' failed`;
  }
}

export class Auth extends Context.Service<
  Auth,
  {
    readonly handle: (request: Request) => Effect.Effect<Response, AuthFailed>;
    readonly session: (headers: Headers) => Effect.Effect<Option.Option<UserId>, AuthFailed>;
    readonly githubToken: (userId: UserId) => Effect.Effect<Redacted.Redacted<string>, AuthFailed>;
  }
>()("@stargrep/auth/auth") {}

export const tokenReadTimeout = Duration.seconds(10);
export const tokenReadTimedOut = () =>
  new AuthFailed({ operation: "token", cause: "Reading the GitHub token timed out" });

export const baseOptions = (database: BetterAuthOptions["database"], config: TokenConfig) =>
  ({
    appName: "Stargrep",
    secret: Redacted.value(config.secret),
    database,
    socialProviders: {
      [providerId]: githubProvider(
        config.clientId,
        Option.getOrUndefined(Option.map(config.clientSecret, Redacted.value)),
      ),
    },
    account: { encryptOAuthTokens: true },
    telemetry: { enabled: false },
    logger: { level: "error" },
  }) satisfies BetterAuthOptions;

type TokenAuth = ReturnType<typeof betterAuth<ReturnType<typeof baseOptions>>>;
type TokenSource = {
  readonly api: {
    readonly getAccessToken: (
      ...args: Parameters<TokenAuth["api"]["getAccessToken"]>
    ) => ReturnType<TokenAuth["api"]["getAccessToken"]>;
  };
  readonly $context: Promise<{
    readonly internalAdapter: Pick<Awaited<TokenAuth["$context"]>["internalAdapter"], "findAccounts">;
  }>;
};

// Better Auth decrypts the stored token, refreshes it when it is within five seconds of expiry, and stores the new one
// encrypted. Better Auth fails a refresh only on an error status. GitHub can name the error in a 200 body instead, and
// Better Auth then answers with the expired token, so an answer that is still expired is a failure here.
export const readGitHubToken = (auth: TokenSource, userId: UserId) =>
  Effect.tryPromise({
    try: async () => {
      const { internalAdapter } = await auth.$context;
      const account = (await internalAdapter.findAccounts(userId)).find((found) => found.providerId === providerId);
      if (account === undefined) throw new Error("The user has no GitHub account");
      return auth.api.getAccessToken({ body: { accountId: account.id, userId } });
    },
    catch: (cause) => new AuthFailed({ operation: "token", cause }),
  }).pipe(
    Effect.flatMap(({ accessToken, accessTokenExpiresAt }) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        accessTokenExpiresAt !== undefined && accessTokenExpiresAt.getTime() <= now
          ? Effect.fail(new AuthFailed({ operation: "token", cause: "The GitHub token expired and did not refresh" }))
          : Effect.succeed(Redacted.make(accessToken)),
      ),
    ),
  );

export const readGitHubTokenWithin = (auth: TokenSource, userId: UserId) =>
  readGitHubToken(auth, userId).pipe(
    Effect.timeoutOrElse({ duration: tokenReadTimeout, orElse: () => Effect.fail(tokenReadTimedOut()) }),
  );

export interface SignIn {
  readonly userId: UserId;
  readonly githubToken: Effect.Effect<Redacted.Redacted<string>, AuthFailed>;
}

export interface Options {
  readonly config: AuthConfig;
  readonly origin: string;
  readonly onSignIn: (signIn: SignIn) => Promise<void>;
  // Runs once for each user Better Auth creates, which a first sign-in does.
  readonly onSignUp: (userId: UserId) => Promise<void>;
}

export interface LayerOptions<R> extends Omit<Options, "onSignIn" | "onSignUp"> {
  readonly connectionString: Redacted.Redacted<string>;
  readonly onSignIn: (signIn: SignIn) => Effect.Effect<void, never, R>;
  readonly onSignUp: (userId: UserId) => Effect.Effect<void, never, R>;
}

const signInPlugins = ({ config, origin }: Pick<Options, "config" | "origin">) => {
  const signIn = config.github;
  if (signIn._tag === "proxied") {
    return [
      oAuthProxy({
        productionURL: signIn.productionOrigin,
        currentURL: origin,
        secret: Redacted.value(signIn.proxySecret),
      }),
    ];
  }
  // Prod only forwards previews' sign-ins, which the plugin's hooks do. Without its endpoints, prod has no route that
  // turns a profile encrypted with the proxy secret into a session.
  return Option.match(signIn.proxySecret, {
    onNone: () => [],
    onSome: (secret) => [
      { ...oAuthProxy({ productionURL: origin, currentURL: origin, secret: Redacted.value(secret) }), endpoints: {} },
    ],
  });
};

export const make = (pool: pg.Pool, options: Options) => {
  const plugins = signInPlugins(options);
  const auth = betterAuth({
    ...baseOptions(drizzleAdapter(drizzle({ client: pool }), { provider: "pg", schema: AuthSchema }), {
      secret: options.config.secret,
      clientId: options.config.github.clientId,
      clientSecret:
        options.config.github._tag === "direct" ? Option.some(options.config.github.clientSecret) : Option.none(),
    }),
    baseURL: options.origin,
    basePath,
    trustedOrigins: [options.origin],
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] }, database: { validateSchema: false } },
    plugins,
    databaseHooks: {
      user: {
        create: {
          after: (user): Promise<void> => options.onSignUp(UserId.make(user.id)),
        },
      },
      session: {
        create: {
          after: (session): Promise<void> => {
            const userId = UserId.make(session.userId);
            return options.onSignIn({ userId, githubToken: tokenOf(userId) });
          },
        },
      },
    },
  });
  const tokenOf: (userId: UserId) => Effect.Effect<Redacted.Redacted<string>, AuthFailed> = Effect.fn(
    "Auth.githubToken",
  )(function* (userId: UserId) {
    return yield* readGitHubTokenWithin(auth, userId);
  });
  return { handler: auth.handler, getSession: auth.api.getSession, tokenOf };
};

const callbackPrefix = `${basePath}/callback/`;

const refused = (origin: string) => Response.redirect(new URL("/?error=redirect_refused", origin).href, 302);

export const layer = <R>(options: LayerOptions<R>) =>
  Layer.effect(
    Auth,
    Effect.gen(function* () {
      const run = Effect.runPromiseWith(yield* Effect.context<R>());
      const pool = yield* acquirePool(Redacted.value(options.connectionString), 2);
      const auth = make(pool, {
        ...options,
        onSignIn: (signIn) => run(options.onSignIn(signIn)),
        onSignUp: (userId) => run(options.onSignUp(userId)),
      });
      return Auth.of({
        handle: Effect.fn("Auth.handle")(function* (request: Request) {
          const response = yield* Effect.tryPromise({
            try: () => auth.handler(request),
            catch: (cause) => new AuthFailed({ operation: "handle", cause }),
          });
          const location = response.headers.get("location");
          const callback = new URL(request.url).pathname.startsWith(callbackPrefix);
          return callback && location !== null && !redirectAllowed(location, options.origin, options.config.previewHost)
            ? refused(options.origin)
            : response;
        }),
        session: Effect.fn("Auth.session")(function* (headers: Headers) {
          const session = yield* Effect.tryPromise({
            try: () => auth.getSession({ headers }),
            catch: (cause) => new AuthFailed({ operation: "session", cause }),
          });
          return Option.map(Option.fromNullishOr(session), ({ user }) => UserId.make(user.id));
        }),
        githubToken: auth.tokenOf,
      });
    }),
  );
