import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export const names = {
  clientId: "GITHUB_APP_CLIENT_ID",
  clientSecret: "GITHUB_APP_CLIENT_SECRET",
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

const direct = (clientId: string) =>
  Config.all({ clientSecret: required(names.clientSecret), proxySecret: optionalSecret(names.proxySecret) }).pipe(
    Config.map(
      ({ clientSecret, proxySecret }): GitHubSignIn => ({ _tag: "direct", clientId, clientSecret, proxySecret }),
    ),
  );

// A proxied stage never reads the client secret, so a preview that proxies through prod cannot hold it.
const proxied = (clientId: string, productionOrigin: string) =>
  required(names.proxySecret).pipe(
    Config.map((proxySecret): GitHubSignIn => ({ _tag: "proxied", clientId, productionOrigin, proxySecret })),
  );

export const githubSignIn: Config.Config<Option.Option<GitHubSignIn>> = Config.all({
  clientId: optionalText(names.clientId),
  proxyOrigin: optionalText(names.proxyOrigin),
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

export const bindings = (config: AuthConfig): Record<string, string | Redacted.Redacted<string>> => {
  const { github } = config;
  const shared = { [names.clientId]: github.clientId, [names.secret]: config.secret };
  return github._tag === "direct"
    ? {
        ...shared,
        [names.clientSecret]: github.clientSecret,
        ...Option.match(github.proxySecret, { onNone: () => ({}), onSome: (key) => ({ [names.proxySecret]: key }) }),
      }
    : { ...shared, [names.proxyOrigin]: github.productionOrigin, [names.proxySecret]: github.proxySecret };
};
