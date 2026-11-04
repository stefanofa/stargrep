import { NotSignedIn, type Viewer, Viewers, ViewerUnavailable } from "@stargrep/api/viewers";
import * as Auth from "@stargrep/auth/auth";
import type { AuthConfig } from "@stargrep/auth/config";
import { SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import type { UserId } from "@stargrep/db/auth-schema";
import * as GitHubAccount from "@stargrep/github/account";
import * as StarCount from "@stargrep/github/star-count";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

const githubTimeout = Duration.seconds(5);

const viewerRequest = HttpClientRequest.get("https://api.github.com/user").pipe(
  HttpClientRequest.accept("application/vnd.github+json"),
);

const github = (request: HttpClientRequest.HttpClientRequest, token: Redacted.Redacted<string>) =>
  HttpClient.execute(
    request.pipe(
      HttpClientRequest.setHeaders({ "x-github-api-version": "2022-11-28", "user-agent": "stargrep" }),
      HttpClientRequest.bearerToken(Redacted.value(token)),
    ),
  ).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.timeout(githubTimeout),
  );

const unavailable = (step: ViewerUnavailable["step"]) => () => Effect.fail(new ViewerUnavailable({ step }));

// The user's own token reads who they are and how many repos they starred, so the sync shows its progress at once.
export const importViewer = Effect.fn("Viewers.import")(
  function* (userId: UserId, token: Redacted.Redacted<string>) {
    const facts = GitHubAccount.toAccount(
      yield* github(viewerRequest, token).pipe(Effect.flatMap(GitHubAccount.decodeUser)),
    );
    const counted = yield* github(StarCount.request(facts.login), token).pipe(Effect.flatMap(StarCount.decodeResponse));
    const starredCount = counted.data?.user?.starredRepositories.totalCount;
    if (starredCount === undefined) return yield* new ViewerUnavailable({ step: "github" });
    const db = yield* Db.Db;
    yield* db.accounts.claim({ facts, userId, starredCount });
    yield* SyncRequests.SyncRequests.use((requests) => requests.request(facts.login)).pipe(
      Effect.catch((error) => Effect.logWarning("Sync after sign-in was not queued", { failure: error._tag })),
    );
    return yield* db.accounts.require(facts.id);
  },
  Effect.catchTags({
    HttpClientError: unavailable("github"),
    SchemaError: unavailable("github"),
    TimeoutError: unavailable("github"),
    AccountNotFound: unavailable("github"),
  }),
);

type ImportServices = Db.Db | SyncRequests.SyncRequests | HttpClient.HttpClient;

const signIn = ({ userId, githubToken }: Auth.SignIn) =>
  githubToken.pipe(
    Effect.flatMap((token) => importViewer(userId, token)),
    Effect.catchCause((cause) => Effect.logWarning("Import after sign-in failed", { cause })),
    Effect.asVoid,
  );

export const layerAuth = (config: AuthConfig, origin: string, connectionString: Redacted.Redacted<string>) =>
  Auth.layer<ImportServices>({ config, origin, connectionString, onSignIn: signIn });

const signedIn = (headers: Headers) =>
  Layer.effect(
    Viewers,
    Effect.gen(function* () {
      const auth = yield* Auth.Auth;
      const db = yield* Db.Db;
      const context = yield* Effect.context<ImportServices>();
      const current = Effect.gen(function* () {
        const session = yield* auth.session(headers).pipe(Effect.catch(unavailable("session")));
        if (Option.isNone(session)) return yield* new NotSignedIn();
        const userId = session.value;
        const claimed = yield* db.accounts.claimedBy(userId);
        if (Option.isSome(claimed)) return { userId, account: claimed.value } satisfies Viewer;
        const token = yield* auth.githubToken(userId).pipe(Effect.catch(unavailable("token")));
        const account = yield* importViewer(userId, token).pipe(Effect.provide(context));
        return { userId, account } satisfies Viewer;
      }).pipe(Effect.withSpan("Viewers.current"));
      return Viewers.of({ current: yield* Effect.cached(current) });
    }),
  );

const signedOut = Layer.succeed(Viewers, Viewers.of({ current: Effect.fail(new NotSignedIn()) }));

export const layerViewers = (
  config: Option.Option<AuthConfig>,
  request: Request,
  connectionString: Redacted.Redacted<string>,
) =>
  Option.match(config, {
    onNone: () => signedOut,
    onSome: (auth) =>
      signedIn(request.headers).pipe(Layer.provide(layerAuth(auth, new URL(request.url).origin, connectionString))),
  });
