import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export const inStage =
  (stage: string) =>
  <A>(effect: Effect.Effect<A, never, Alchemy.Stack | Cloudflare.Providers>) =>
    Effect.runSync(
      effect.pipe(
        Effect.provideService(Alchemy.Stack, { name: "Stargrep", stage, resources: {}, bindings: {} } as never),
        Effect.provideService(Cloudflare.Providers, {} as never),
      ),
    );
