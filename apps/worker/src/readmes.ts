import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";

// A preview's READMEs are a disposable cache, so its destroy empties the bucket. Prod's bucket is never emptied or deleted.
export const Readmes = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  return yield* stage === "prod"
    ? Cloudflare.R2.Bucket("Readmes").pipe(RemovalPolicy.retain())
    : Cloudflare.R2.Bucket("Readmes", { forceDestroy: true });
});
