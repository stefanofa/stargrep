import * as Db from "@stargrep/db";
import type { UserId } from "@stargrep/db/auth-schema";
import { GitHub } from "@stargrep/github/github";
import { loginKey } from "@stargrep/github/login";
import type { Login } from "@stargrep/github/schemas";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Requester, SyncRequests } from "./sync-requests.ts";

export class OwnerImportFailed extends Schema.TaggedError<OwnerImportFailed, { readonly brand: unique symbol }>()(
  "OwnerImportFailed",
  {},
) {
  override get message() {
    return "The signed-in GitHub account could not be read";
  }
}

// Who asks for a login's sync. A signed-in user whose claimed account is that login asks as its owner.
export const requesterOf = Effect.fn("OwnerAccount.requesterOf")(function* (
  login: Login,
  signedIn: Option.Option<UserId>,
  caller: Db.CallerKey,
) {
  if (Option.isNone(signedIn)) return { _tag: "anyone", caller } satisfies Requester;
  const userId = signedIn.value;
  const claimed = yield* (yield* Db.Db).accounts.claimedBy(userId);
  return Option.exists(claimed, (account) => loginKey(account.login) === loginKey(login))
    ? ({ _tag: "owner", userId } satisfies Requester)
    : ({ _tag: "signed-in", userId, caller } satisfies Requester);
});

// The owner's sync runs on their own token and never waits in line, so only the queue or the database can fail it. A
// sync that didn't queue still answers the login's status, which says the sync failed when the queue refused it.
export const requestOwnerSync = (login: Login, userId: UserId, after: "sign-in" | "page open") =>
  SyncRequests.use((requests) =>
    requests
      .request(login, { _tag: "owner", userId })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Owner sync was not queued", { after, failure: error._tag }).pipe(
            Effect.andThen(requests.status(login)),
          ),
        ),
      ),
  );

export const importViewer = Effect.fn("OwnerAccount.importViewer")(function* (userId: UserId) {
  const { account: facts, starredCount } = yield* GitHub.use((github) => github.viewer).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError(() => new OwnerImportFailed()),
  );
  const db = yield* Db.Db;
  yield* db.accounts.claim({ facts, userId, starredCount });
  return yield* db.accounts.require(facts.id).pipe(Effect.catchTags({ AccountNotFound: Effect.die }));
});
