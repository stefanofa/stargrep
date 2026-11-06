import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { AppCredentials, Signer } from "./app-jwt.ts";
import * as AppJwt from "./app-jwt.ts";
import { GitHubRequestFailed, GitHubTokenMissing, type Operation, TokenBudgetExhausted } from "./errors.ts";
import { apiHeaders } from "./headers.ts";
import * as RateLimit from "./rate-limit.ts";
import * as TokenGate from "./token-gate.ts";

const api = "https://api.github.com";
// A request holds a token for at most its 30 second exchange, so a token with more than a minute left outlives it.
const stillUsable = Duration.toMillis(Duration.minutes(1));
// In a token's last five minutes, one refresh runs in the background while requests keep the held token.
const refreshMargin = Duration.toMillis(Duration.minutes(5));

const App = Schema.Struct({ owner: Schema.Struct({ login: Schema.String, type: Schema.String }) });
const Installation = Schema.Struct({ id: Schema.Int });
const AccessToken = Schema.Struct({ token: Schema.String, expires_at: Schema.DateTimeUtcFromString });

// Why minting stopped: the key does not import or sign, GitHub refused the JWT or the App, or the App is not installed
// on its owner's account. Each needs the operator, so the gate reports the token as missing.
class AppTokenRefused extends Schema.TaggedError<AppTokenRefused, { readonly brand: unique symbol }>()(
  "AppTokenRefused",
  { reason: Schema.Literals(["key", "jwt-rejected", "forbidden", "not-found", "installation"]) },
) {
  override get message(): string {
    return `Minting a GitHub App installation token stopped: ${this.reason}`;
  }
}

// GitHub rate limited the App's own endpoints. The gate reports it like a spent budget, so the queue sends the message
// again after resetAt without spending a retry.
class MintRateLimited extends Schema.TaggedError<MintRateLimited, { readonly brand: unique symbol }>()(
  "MintRateLimited",
  { resetAt: Schema.Int },
) {
  override get message(): string {
    return "GitHub rate limited minting an installation token";
  }
}

interface Minted {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: number;
}

export interface State {
  readonly held: Option.Option<Minted>;
  readonly installation: Option.Option<number>;
  // No mint goes out before this time, the end of a rate limit GitHub named.
  readonly mintAfter: number;
}

const initial: State = { held: Option.none(), installation: Option.none(), mintAfter: 0 };

export type Plan = Data.TaggedEnum<{
  Use: { readonly token: Redacted.Redacted<string> };
  UseAndRefresh: { readonly token: Redacted.Redacted<string> };
  Wait: { readonly resetAt: number };
  Mint: Record<never, never>;
}>;
export const Plan = Data.taggedEnum<Plan>();

export const plan = (state: State, now: number): Plan => {
  const usable = Option.filter(state.held, (held) => held.expiresAt - now > stillUsable);
  if (Option.isSome(usable)) {
    const { token, expiresAt } = usable.value;
    return expiresAt - now <= refreshMargin && now >= state.mintAfter
      ? Plan.UseAndRefresh({ token })
      : Plan.Use({ token });
  }
  return now < state.mintAfter ? Plan.Wait({ resetAt: state.mintAfter }) : Plan.Mint();
};

export interface Options {
  readonly credentials: AppCredentials;
  // Signs each mint's JWT. WebCrypto by default.
  readonly signer?: Signer;
}

// The App's installation token as a gate's token source. It mints for the installation on the account that owns the App,
// so installs on other accounts never change it, and keeps the token in memory, never in storage. A background refresh
// runs in the scope the caller provides, which outlives the requests.
export const makeInstallationTokens = Effect.fn("AppToken.makeInstallationTokens")(function* (options: Options) {
  const client = yield* HttpClient.HttpClient;
  const scope = yield* Scope.Scope;
  const sign = options.signer ?? (yield* AppJwt.signer(options.credentials));
  const state = yield* Ref.make(initial);
  // One mint at a time, foreground or background.
  const mintPermit = yield* Semaphore.make(1);

  const exchange = Effect.fnUntraced(function* (
    request: HttpClientRequest.HttpClientRequest,
    jwt: Redacted.Redacted<string>,
  ) {
    const endpoint = { operation: "app-token", method: request.method, path: new URL(request.url).pathname } as const;
    const reply = yield* TokenGate.send(
      client,
      endpoint,
      request.pipe(
        HttpClientRequest.setHeaders({ ...apiHeaders, accept: "application/vnd.github+json" }),
        HttpClientRequest.bearerToken(jwt),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    if (reply.status === 401) return yield* new AppTokenRefused({ reason: "jwt-rejected" });
    if (reply.status === 404) return yield* new AppTokenRefused({ reason: "not-found" });
    if (RateLimit.isRateLimit(reply, now)) {
      return yield* new MintRateLimited({ resetAt: now + RateLimit.retryAfterMillis(reply, now) });
    }
    if (reply.status === 403) return yield* new AppTokenRefused({ reason: "forbidden" });
    const failed = (reason: "status" | "malformed") =>
      new GitHubRequestFailed({ ...endpoint, status: reply.status, reason });
    if (!TokenGate.isSuccess(reply.status)) return yield* failed("status");
    return yield* Effect.mapError(Effect.fromOption(reply.body), () => failed("malformed")).pipe(
      Effect.map((body) => ({ body, malformed: () => failed("malformed") })),
    );
  });

  const decoded = <S extends Schema.Top>(
    schema: S,
    reply: { readonly body: string; readonly malformed: () => GitHubRequestFailed },
  ) => Schema.decodeEffect(Schema.fromJsonString(schema))(reply.body).pipe(Effect.mapError(reply.malformed));

  const lookUpInstallation = Effect.fnUntraced(function* (jwt: Redacted.Redacted<string>) {
    const app = yield* decoded(App, yield* exchange(HttpClientRequest.get(`${api}/app`), jwt));
    const owner = encodeURIComponent(app.owner.login);
    const path = app.owner.type === "Organization" ? `/orgs/${owner}/installation` : `/users/${owner}/installation`;
    const found = yield* exchange(HttpClientRequest.get(`${api}${path}`), jwt).pipe(
      Effect.catchTag("AppTokenRefused", (refused) =>
        Effect.fail(refused.reason === "not-found" ? new AppTokenRefused({ reason: "installation" }) : refused),
      ),
      Effect.flatMap((reply) => decoded(Installation, reply)),
    );
    yield* Ref.update(state, (current) => ({ ...current, installation: Option.some(found.id) }));
    return found.id;
  });

  const accessToken = (id: number, jwt: Redacted.Redacted<string>) =>
    Effect.flatMap(exchange(HttpClientRequest.post(`${api}/app/installations/${id}/access_tokens`), jwt), (reply) =>
      decoded(AccessToken, reply),
    );

  // An App installed again gets a new installation ID, so a 404 for the known one looks it up once more.
  const mint = Effect.gen(function* () {
    const jwt = yield* sign.pipe(Effect.mapError(() => new AppTokenRefused({ reason: "key" })));
    const known = (yield* Ref.get(state)).installation;
    const minted = yield* Option.match(known, {
      onNone: () => Effect.flatMap(lookUpInstallation(jwt), (id) => accessToken(id, jwt)),
      onSome: (id) =>
        accessToken(id, jwt).pipe(
          Effect.catchTag("AppTokenRefused", (refused) =>
            refused.reason === "not-found"
              ? Effect.flatMap(lookUpInstallation(jwt), (fresh) => accessToken(fresh, jwt))
              : Effect.fail(refused),
          ),
        ),
    });
    const held = { token: Redacted.make(minted.token), expiresAt: minted.expires_at.epochMilliseconds };
    yield* Ref.update(state, (current) => ({ ...current, held: Option.some(held) }));
    return held.token;
  }).pipe(
    Effect.tapError((failure) =>
      failure._tag === "MintRateLimited"
        ? Ref.update(state, (current) => ({ ...current, mintAfter: failure.resetAt }))
        : Effect.void,
    ),
  );

  const refreshInBackground = Effect.gen(function* () {
    if (!(yield* mintPermit.takeIfAvailable(1))) return;
    yield* Effect.forkIn(
      mint.pipe(
        Effect.catch((failure) =>
          Effect.logWarning("Kept the held installation token after a failed refresh", { failure: failure._tag }),
        ),
        Effect.ensuring(mintPermit.release(1)),
        Effect.asVoid,
      ),
      scope,
    );
  });

  const gateError = (
    operation: Operation,
    failure: AppTokenRefused | MintRateLimited | GitHubRequestFailed,
  ): Effect.Effect<never, GitHubRequestFailed | GitHubTokenMissing | TokenBudgetExhausted> => {
    switch (failure._tag) {
      case "AppTokenRefused":
        return Effect.andThen(
          Effect.logError("Could not mint a GitHub App installation token", { reason: failure.reason }),
          Effect.fail(new GitHubTokenMissing({ operation })),
        );
      case "MintRateLimited":
        return Effect.andThen(
          Effect.logWarning("GitHub rate limited minting an installation token", { resetAt: failure.resetAt }),
          Effect.fail(new TokenBudgetExhausted({ resource: "core", resetAt: failure.resetAt })),
        );
      case "GitHubRequestFailed":
        return Effect.fail(failure);
    }
  };

  const decide = Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.map(Ref.get(state), (current) => plan(current, now)),
  );

  type Resolved = Effect.Effect<
    Redacted.Redacted<string>,
    GitHubRequestFailed | GitHubTokenMissing | TokenBudgetExhausted
  >;

  const mintNow = (operation: Operation): Resolved =>
    mint.pipe(Effect.catch((failure) => gateError(operation, failure)));

  // A request with no usable token waits for the mint permit, then decides again, because the mint that held it may
  // have stored a token or a wait.
  const resolve = (operation: Operation, next: Plan, holdsPermit: boolean): Resolved => {
    switch (next._tag) {
      case "Use":
        return Effect.succeed(next.token);
      case "UseAndRefresh":
        return holdsPermit ? Effect.succeed(next.token) : Effect.as(refreshInBackground, next.token);
      case "Wait":
        return Effect.fail(new TokenBudgetExhausted({ resource: "core", resetAt: next.resetAt }));
      case "Mint":
        return holdsPermit
          ? mintNow(operation)
          : mintPermit.withPermit(Effect.flatMap(decide, (again) => resolve(operation, again, true)));
    }
  };

  const source: TokenGate.TokenSource = {
    current: (operation) => Effect.flatMap(decide, (next) => resolve(operation, next, false)),
    // GitHub revokes an installation's tokens when its App is installed again, so the next request mints a new one.
    rejected: Effect.as(
      Ref.update(state, (current) => ({ ...current, held: Option.none() })),
      true,
    ),
  };
  // Waits for a background refresh to finish.
  return { ...source, refreshed: mintPermit.withPermit(Effect.void) };
});
