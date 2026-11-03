import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// The CLI's --yes also lets a deploy create or upgrade the account's state store, which other projects share.
// Deploys never maintain the store, so CI fails on a missing or outdated one (docs/setup.md has the manual command).
const withoutStoreMaintenance = Layer.effect(
  AlchemyContext,
  Effect.gen(function* () {
    return { ...(yield* AlchemyContext), updateStateStore: false };
  }),
);

// Cloudflare.state() resolves a Cloudflare account on load, so alchemy dev keeps its state on disk and runs with no credentials.
export const state = Layer.unwrap(
  Effect.gen(function* () {
    return (yield* Alchemy.ALCHEMY_DEV)
      ? Alchemy.localState()
      : Cloudflare.state().pipe(Layer.provide(withoutStoreMaintenance));
  }).pipe(Effect.orDie),
);
