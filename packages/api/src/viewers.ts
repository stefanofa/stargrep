import { SyncRequests } from "@stargrep/core/stars";
import type * as Db from "@stargrep/db";
import type { UserId } from "@stargrep/db/auth-schema";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import type { Login } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class NotSignedIn extends Schema.TaggedError<NotSignedIn, { readonly brand: unique symbol }>()(
  "NotSignedIn",
  {},
) {
  override get message(): string {
    return "No one is signed in";
  }
}

export class ViewerUnavailable extends Schema.TaggedError<ViewerUnavailable, { readonly brand: unique symbol }>()(
  "ViewerUnavailable",
  {
    step: Schema.Literals(["session", "token", "github"]),
  },
) {
  override get message(): string {
    return `The signed-in account could not be read at the ${this.step} step`;
  }
}

export interface Viewer {
  readonly userId: UserId;
  readonly account: Db.Account;
}

export type ViewerError =
  | NotSignedIn
  | ViewerUnavailable
  | DbQueryFailed
  | DbRowInvalid
  | SyncRequests.SyncRequestError;

export class Viewers extends Context.Service<
  Viewers,
  {
    readonly current: Effect.Effect<Viewer, ViewerError>;
    // Who is signed in, from the session alone, for a request that works the same signed out.
    readonly signedIn: Effect.Effect<Option.Option<UserId>, ViewerUnavailable>;
  }
>()("@stargrep/api/viewers") {}

// A sync that fails to queue never fails the sign-in or the viewer call.
export const requestOwnerSync = (login: Login, userId: UserId, after: "sign-in" | "library open") =>
  SyncRequests.SyncRequests.use((requests) => requests.request(login, { _tag: "owner", userId })).pipe(
    Effect.catch((error) => Effect.logWarning("Owner sync was not queued", { after, failure: error._tag })),
  );
