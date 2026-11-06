import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const names = {
  clientId: "STARGREP_GITHUB_APP_CLIENT_ID",
  clientSecret: "STARGREP_GITHUB_APP_CLIENT_SECRET",
  proxyOrigin: "AUTH_PROXY_ORIGIN",
  proxySecret: "AUTH_PROXY_SECRET",
  secret: "BETTER_AUTH_SECRET",
} as const;

export type GitHubSignIn =
  | {
      readonly _tag: "direct";
      readonly clientId: string;
      readonly clientSecret: Redacted.Redacted<string>;
      readonly proxySecret: Option.Option<Redacted.Redacted<string>>;
    }
  | {
      readonly _tag: "proxied";
      readonly clientId: string;
      readonly productionOrigin: string;
      readonly proxySecret: Redacted.Redacted<string>;
    };

export interface AuthConfig {
  readonly secret: Redacted.Redacted<string>;
  readonly github: GitHubSignIn;
}

export const required = (name: string) => Config.schema(Schema.Redacted(Schema.NonEmptyString), name);

// Actions passes a secret or variable that is not set as an empty string.
const optionalText = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.filter((value) => value !== "")));

export const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(Config.option, Config.map(Option.filter((value) => Redacted.value(value) !== "")));

// A proxy origin is where GitHub sends previews back, so it is an https origin with nothing after the host.
const Origin = Schema.String.check(
  Schema.makeFilter((value: string) => {
    const url = URL.parse(value);
    return (
      (url !== null && url.protocol === "https:" && url.origin === value) ||
      "an https origin with no path, such as https://stargrep.com"
    );
  }),
);

const optionalOrigin = (name: string) =>
  Config.schema(Schema.Union([Schema.Literal(""), Origin]), name).pipe(
    Config.option,
    Config.map(Option.filter((value) => value !== "")),
  );

const direct = (clientId: string) =>
  Config.all({ clientSecret: required(names.clientSecret), proxySecret: optionalSecret(names.proxySecret) }).pipe(
    Config.map(
      ({ clientSecret, proxySecret }): GitHubSignIn => ({ _tag: "direct", clientId, clientSecret, proxySecret }),
    ),
  );

const proxied = (clientId: string, productionOrigin: string) =>
  required(names.proxySecret).pipe(
    Config.map((proxySecret): GitHubSignIn => ({ _tag: "proxied", clientId, productionOrigin, proxySecret })),
  );

export const githubSignIn: Config.Config<Option.Option<GitHubSignIn>> = Config.all({
  clientId: optionalText(names.clientId),
  proxyOrigin: optionalOrigin(names.proxyOrigin),
}).pipe(
  Config.flatMap(({ clientId, proxyOrigin }) =>
    Option.match(clientId, {
      onNone: () => Config.succeed(Option.none()),
      onSome: (id) =>
        Option.match(proxyOrigin, { onNone: () => direct(id), onSome: (origin) => proxied(id, origin) }).pipe(
          Config.map(Option.some),
        ),
    }),
  ),
);

export const authConfig: Config.Config<Option.Option<AuthConfig>> = Config.all({
  github: githubSignIn,
  secret: optionalSecret(names.secret),
}).pipe(
  Config.map(({ github, secret }) =>
    Option.zipWith(github, secret, (signIn, key) => ({ github: signIn, secret: key })),
  ),
);

export interface TokenConfig {
  readonly secret: Redacted.Redacted<string>;
  readonly clientId: string;
  // A stage that signs in through prod's proxy has no client secret, so a token there cannot refresh.
  readonly clientSecret: Option.Option<Redacted.Redacted<string>>;
}

// What reading a signed-in user's GitHub token needs, without the routes or the proxy.
export const tokenConfig: Config.Config<Option.Option<TokenConfig>> = Config.all({
  clientId: optionalText(names.clientId),
  clientSecret: optionalSecret(names.clientSecret),
  secret: optionalSecret(names.secret),
}).pipe(
  Config.map(({ clientId, clientSecret, secret }) =>
    Option.zipWith(clientId, secret, (id, key) => ({ clientId: id, clientSecret, secret: key })),
  ),
);

// What the main Worker binds to read and refresh users' tokens: the client ID, and the client secret only on a stage that
// signs in directly. Alchemy evaluates a Worker's props again each time the Worker starts, against that Worker's own
// bindings, which hold no proxy origin or proxy secret. So every value here is optional, and the same env gives the same
// answer at deploy and at start.
export const tokenClientBindings: Config.Config<Record<string, string | Redacted.Redacted<string>>> = Config.all({
  clientId: optionalText(names.clientId),
  clientSecret: optionalSecret(names.clientSecret),
  proxyOrigin: optionalText(names.proxyOrigin),
}).pipe(
  Config.map(({ clientId, clientSecret, proxyOrigin }) =>
    Option.match(clientId, {
      onNone: () => ({}),
      onSome: (id) => ({
        [names.clientId]: id,
        ...(Option.isNone(proxyOrigin) && Option.isSome(clientSecret)
          ? { [names.clientSecret]: clientSecret.value }
          : {}),
      }),
    }),
  ),
);

export const bindings = (github: GitHubSignIn): Record<string, string | Redacted.Redacted<string>> =>
  github._tag === "direct"
    ? {
        [names.clientId]: github.clientId,
        [names.clientSecret]: github.clientSecret,
        ...Option.match(github.proxySecret, { onNone: () => ({}), onSome: (key) => ({ [names.proxySecret]: key }) }),
      }
    : {
        [names.clientId]: github.clientId,
        [names.proxyOrigin]: github.productionOrigin,
        [names.proxySecret]: github.proxySecret,
      };
