import * as Cloudflare from "@alchemy.run/cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { settings } from "../stage.ts";

// The web Worker serves icons from this bucket at /icons/<key>. A preview's bucket is disposable, so its destroy
// empties it. Prod's bucket is never emptied or deleted.
export const Icons = Effect.gen(function* () {
  const { retain } = yield* settings;
  return yield* retain
    ? Cloudflare.R2.Bucket("Icons").pipe(RemovalPolicy.retain())
    : Cloudflare.R2.Bucket("Icons", { forceDestroy: true });
});
