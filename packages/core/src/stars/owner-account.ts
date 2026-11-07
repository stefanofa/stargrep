import * as Db from "@stargrep/db";
import type { UserId } from "@stargrep/db/auth-schema";
import { GitHub } from "@stargrep/github/github";
import type { Login } from "@stargrep/github/schemas";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SyncRequests } from "./sync-requests.ts";

export class OwnerImportFailed extends Schema.TaggedError<OwnerImportFailed, { readonly brand: unique symbol }>()(
  "OwnerImportFailed",
  {},
) {
  override get message() {
    return "The signed-in GitHub account could not be read";
  }
}

export const requestOwnerSync = (login: Login, userId: UserId, after: "sign-in" | "library open") =>
  SyncRequests.use((requests) => requests.request(login, { _tag: "owner", userId })).pipe(
    Effect.catch((error) => Effect.logWarning("Owner sync was not queued", { after, failure: error._tag })),
  );

export const importViewer = Effect.fn("OwnerAccount.importViewer")(function* (userId: UserId) {
  const { account: facts, starredCount } = yield* GitHub.use((github) => github.viewer).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError(() => new OwnerImportFailed()),
  );
  const db = yield* Db.Db;
  yield* db.accounts.claim({ facts, userId, starredCount });
  yield* requestOwnerSync(facts.login, userId, "sign-in");
  return yield* db.accounts.require(facts.id).pipe(Effect.catchTags({ AccountNotFound: Effect.die }));
});
