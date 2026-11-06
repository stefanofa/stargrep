import * as AuthSchema from "@stargrep/db/auth-schema";
import { UserId } from "@stargrep/db/auth-schema";
import { acquirePool } from "@stargrep/db/node-postgres";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { oAuthProxy } from "better-auth/plugins/oauth-proxy";
import { drizzle } from "drizzle-orm/node-postgres";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type pg from "pg";
import type { AuthConfig } from "./config.ts";

export const basePath = "/auth";
export const providerId = "github";

// The proxy secret sits in the preview environment, which every branch's workflow can read. So prod forwards a
// preview's sign-in, which carries the user's GitHub token, only to a preview Worker of this account.
export const previewHost = /^stargrep-web-pr-\d+-[a-z0-9]+\.rewebdotso\.workers\.dev$/;

export const redirectAllowed = (location: string, origin: string) => {
  const target = URL.parse(location, origin);
  return (
    target !== null &&
    (target.origin === origin ||
      (target.protocol === "https:" && target.port === "" && previewHost.test(target.hostname)))
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

interface TokenSource {
  readonly $context: Promise<{
    readonly internalAdapter: {
      readonly findAccounts: (
        userId: string,
      ) => Promise<ReadonlyArray<{ readonly id: string; readonly providerId: string }>>;
    };
  }>;
  readonly api: {
    readonly getAccessToken: (input: {
      readonly body: { readonly accountId: string; readonly userId: string };
    }) => Promise<{ readonly accessToken: string; readonly accessTokenExpiresAt?: Date | undefined }>;
  };
}

// Better Auth decrypts the stored token, refreshes it when it is within five seconds of expiry, and stores the new one
// encrypted. GitHub refuses a revoked or expired refresh token with a 200 that names an error, and Better Auth then
// answers with the expired token, so an answer that is still expired is a failure here.
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

export interface SignIn {
  readonly userId: UserId;
  readonly githubToken: Effect.Effect<Redacted.Redacted<string>, AuthFailed>;
}

export interface Options {
  readonly config: AuthConfig;
  readonly origin: string;
  readonly onSignIn: (signIn: SignIn) => Promise<void>;
}

export interface LayerOptions<R> extends Omit<Options, "onSignIn"> {
  readonly connectionString: Redacted.Redacted<string>;
  readonly onSignIn: (signIn: SignIn) => Effect.Effect<void, never, R>;
}

export const signInOptions = ({ config, origin }: Pick<Options, "config" | "origin">) => {
  const signIn = config.github;
  if (signIn._tag === "proxied") {
    return {
      provider: { clientId: signIn.clientId },
      plugins: [
        oAuthProxy({
          productionURL: signIn.productionOrigin,
          currentURL: origin,
          secret: Redacted.value(signIn.proxySecret),
        }),
      ],
    };
  }
  // Prod only forwards previews' sign-ins, which the plugin's hooks do. Without its endpoints, prod has no route that
  // turns a profile encrypted with the proxy secret into a session.
  return {
    provider: { clientId: signIn.clientId, clientSecret: Redacted.value(signIn.clientSecret) },
    plugins: Option.match(signIn.proxySecret, {
      onNone: () => [],
      onSome: (secret) => [
        {
          ...oAuthProxy({ productionURL: origin, currentURL: origin, secret: Redacted.value(secret) }),
          endpoints: {},
        },
      ],
    }),
  };
};

export const make = (pool: pg.Pool, options: Options) => {
  const { provider, plugins } = signInOptions(options);
  const auth = betterAuth({
    appName: "Stargrep",
    baseURL: options.origin,
    basePath,
    secret: Redacted.value(options.config.secret),
    trustedOrigins: [options.origin],
    database: drizzleAdapter(drizzle({ client: pool }), { provider: "pg", schema: AuthSchema }),
    socialProviders: { [providerId]: provider },
    account: { encryptOAuthTokens: true },
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] }, database: { validateSchema: false } },
    telemetry: { enabled: false },
    logger: { level: "error" },
    plugins,
    databaseHooks: {
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
    return yield* readGitHubToken(auth, userId);
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
      const auth = make(pool, { ...options, onSignIn: (signIn) => run(options.onSignIn(signIn)) });
      return Auth.of({
        handle: Effect.fn("Auth.handle")(function* (request: Request) {
          const response = yield* Effect.tryPromise({
            try: () => auth.handler(request),
            catch: (cause) => new AuthFailed({ operation: "handle", cause }),
          });
          const location = response.headers.get("location");
          const callback = new URL(request.url).pathname.startsWith(callbackPrefix);
          return callback && location !== null && !redirectAllowed(location, options.origin)
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
