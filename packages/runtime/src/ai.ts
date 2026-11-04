import * as Gateway from "@stargrep/ai/gateway";
import * as Models from "@stargrep/ai/models";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

// Actions passes a secret that is not set as an empty string, and the process environment keeps it.
export const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(Config.option, Config.map(Option.filter((value) => Redacted.value(value) !== "")));

export const aiGatewayKeyName = "AI_GATEWAY_API_KEY";

export const aiGatewayKey = optionalSecret(aiGatewayKeyName);

type Key = Option.Option<Redacted.Redacted<string>>;

export const layerSummaries = (key: Key) =>
  Option.match(key, {
    onNone: () => Gateway.layerKeyMissing,
    onSome: (apiKey) => Gateway.layerModels(Gateway.layerProvider({ apiKey }), { batch: false }),
  });

export const layerSearch = (key: Key) =>
  Option.match(key, {
    onNone: () =>
      Layer.merge(Gateway.keyMissingText(Models.plannerModel), Gateway.keyMissingEmbeddings(Models.embeddingModel)),
    onSome: (apiKey) =>
      Layer.merge(Gateway.layerPlanner, Gateway.layerEmbeddings(Models.embeddingModel)).pipe(
        Layer.provide(Gateway.layerProvider({ apiKey })),
      ),
  });
