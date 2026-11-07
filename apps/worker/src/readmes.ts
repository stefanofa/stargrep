import * as Cloudflare from "@alchemy.run/cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { settings } from "./stage.ts";

// A preview's READMEs are a disposable cache, so its destroy empties the bucket. Prod's bucket is never emptied or deleted.
export const Readmes = Effect.gen(function* () {
  const { retain } = yield* settings;
  return yield* retain
    ? Cloudflare.R2.Bucket("Readmes").pipe(RemovalPolicy.retain())
    : Cloudflare.R2.Bucket("Readmes", { forceDestroy: true });
});
