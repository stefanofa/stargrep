import * as Gateway from "@stargrep/ai/gateway";
import * as StandIn from "@stargrep/ai/stand-in";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { optionalSecret } from "./config.ts";
import { type StageSettings, stageSettings } from "./stage.ts";

export const aiGatewayKey = optionalSecret(Gateway.apiKeyName);

export const aiProviderName = "STARGREP_AI_PROVIDER";

type AiProvider = StageSettings["defaultAiProvider"];

const aiProviderOr = (fallback: AiProvider): Config.Config<AiProvider> =>
  Config.schema(Schema.Literals(["gateway", "fake", ""]), aiProviderName).pipe(
    Config.withDefault(""),
    Config.map((provider) => (provider === "" ? fallback : provider)),
  );

export type AiSetup =
  | { readonly provider: "fake" }
  | { readonly provider: "gateway"; readonly key: Option.Option<Redacted.Redacted<string>> };

// Prod binds no provider, so a Worker without the binding calls the models. At deploy it reads the provider the
// stage chose.
export const aiProvider = aiProviderOr("gateway");

export const aiSetup: Config.Config<AiSetup> = aiProvider.pipe(
  Config.flatMap((provider) =>
    provider === "fake"
      ? Config.succeed({ provider })
      : Config.map(aiGatewayKey, (key): AiSetup => ({ provider, key })),
  ),
);

// The main Worker's summaries and embeddings.
export const layerModels = (ai: AiSetup) =>
  ai.provider === "fake" ? StandIn.layerModels : Gateway.layerModelsForKey(ai.key, { batch: false });

// The web Worker's planner and query embeddings.
export const layerSearch = (ai: AiSetup) =>
  ai.provider === "fake" ? StandIn.layerSearch : Gateway.layerSearchForKey(ai.key);

const isName = (path: ConfigProvider.Path, name: string) => path.length === 1 && path[0] === name;

// The deploy reads every resource's config through this. A stage on the fakes cannot bind the AI key, because its
// Workers never see one, and each non-prod Worker binds the provider its stage chose. Prod reads its config as before,
// except that the provider variable is hidden, so a stray one in prod's environment changes nothing.
export const withStageAi =
  (stage: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const { production, defaultAiProvider } = stageSettings(stage);
      const provider = production ? "gateway" : yield* aiProviderOr(defaultAiProvider);
      const base = yield* ConfigProvider.ConfigProvider;
      const shaped = ConfigProvider.make((path) => {
        if (isName(path, aiProviderName))
          return Effect.succeed(production ? undefined : ConfigProvider.makeValue(provider));
        if (isName(path, Gateway.apiKeyName) && provider === "fake") return Effect.succeed(undefined);
        return base.load(path);
      });
      return yield* Effect.provideService(effect, ConfigProvider.ConfigProvider, shaped);
    });
