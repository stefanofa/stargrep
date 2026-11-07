import { NotSignedIn, type Viewer, Viewers, ViewerUnavailable } from "@stargrep/api/viewers";
import * as Auth from "@stargrep/auth/auth";
import type { AuthConfig } from "@stargrep/auth/config";
import type { SyncRequests } from "@stargrep/core/stars";
import { OwnerAccount } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import type { UserId } from "@stargrep/db/auth-schema";
import { userShare } from "@stargrep/github/fallback-gate";
import * as GitHub from "@stargrep/github/github";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

const unavailable = (step: ViewerUnavailable["step"]) => () => Effect.fail(new ViewerUnavailable({ step }));

export const importViewer = (userId: UserId, token: Redacted.Redacted<string>) =>
  OwnerAccount.importViewer(userId).pipe(
    Effect.provide(GitHub.layer.pipe(Layer.provide(TokenGate.layerMemory({ token, share: userShare })))),
    Effect.catchTags({ OwnerImportFailed: unavailable("github") }),
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
      const signedIn = yield* Effect.cached(auth.session(headers).pipe(Effect.catch(unavailable("session"))));
      const current = Effect.gen(function* () {
        const session = yield* signedIn;
        if (Option.isNone(session)) return yield* new NotSignedIn();
        const userId = session.value;
        const claimed = yield* db.accounts.claimedBy(userId);
        if (Option.isSome(claimed)) return { userId, account: claimed.value } satisfies Viewer;
        const token = yield* auth.githubToken(userId).pipe(Effect.catch(unavailable("token")));
        const account = yield* importViewer(userId, token).pipe(Effect.provide(context));
        return { userId, account } satisfies Viewer;
      }).pipe(Effect.withSpan("Viewers.current"));
      return Viewers.of({ current: yield* Effect.cached(current), signedIn });
    }),
  );

const signedOut = Layer.succeed(
  Viewers,
  Viewers.of({ current: Effect.fail(new NotSignedIn()), signedIn: Effect.succeedNone }),
);

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
