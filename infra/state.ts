import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Cloudflare.state() resolves a Cloudflare account on load, so alchemy dev keeps its state on disk and runs with no credentials.
export const state = Layer.unwrap(
  Effect.gen(function* () {
    return (yield* Alchemy.ALCHEMY_DEV) ? Alchemy.localState() : Cloudflare.state();
  }).pipe(Effect.orDie),
);
