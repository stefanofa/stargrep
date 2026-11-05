import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";

// The web Worker serves icons from this bucket at /icons/<key>. A preview's bucket is disposable, so its destroy
// empties it. Prod's bucket is never emptied or deleted.
export const Icons = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  return yield* stage === "prod"
    ? Cloudflare.R2.Bucket("Icons").pipe(RemovalPolicy.retain())
    : Cloudflare.R2.Bucket("Icons", { forceDestroy: true });
});
