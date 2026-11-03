import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ClaudeCode from "./claude-code.ts";
import * as Fake from "./fake.ts";
import * as Gateway from "./gateway.ts";
import * as Models from "./models.ts";
import * as SummarizeFake from "./prompts/summarize.fake.ts";

const TextProvider = Schema.Literals(["gateway", "claude-code", "fake"]);
type TextProvider = typeof TextProvider.Type;

const EmbeddingsProvider = Schema.Literals(["gateway", "fake"]);
type EmbeddingsProvider = typeof EmbeddingsProvider.Type;

const Mode = Schema.Literals(["local", "deployed"]);

export class AiProviderNotAllowed extends Schema.TaggedError<AiProviderNotAllowed>()("AiProviderNotAllowed", {
  provider: Schema.String,
  reason: Schema.Literals(["not-local", "ci"]),
}) {
  override get message(): string {
    return this.reason === "ci"
      ? `AI provider '${this.provider}' never runs in CI`
      : `AI provider '${this.provider}' runs only when STARGREP_MODE is local`;
  }
}

const settings = Config.all({
  mode: Config.schema(Mode, "STARGREP_MODE").pipe(Config.withDefault("deployed" as const)),
  ci: Config.Boolean("CI").pipe(Config.withDefault(false)),
  text: Config.schema(TextProvider, "AI_TEXT_PROVIDER").pipe(Config.withDefault("gateway" as const)),
  embeddings: Config.schema(EmbeddingsProvider, "AI_EMBEDDINGS_PROVIDER").pipe(Config.withDefault("gateway" as const)),
  claudeCodeModel: Config.String("AI_CLAUDE_CODE_MODEL").pipe(Config.withDefault("haiku")),
});

const requireLocal = (provider: string, mode: typeof Mode.Type, ci: boolean) => {
  if (provider === "gateway") return Effect.void;
  if (ci) return Effect.fail(new AiProviderNotAllowed({ provider, reason: "ci" }));
  if (mode !== "local") return Effect.fail(new AiProviderNotAllowed({ provider, reason: "not-local" }));
  return Effect.void;
};

const textLayer = (provider: TextProvider, claudeCodeModel: string) => {
  switch (provider) {
    case "gateway":
      return Gateway.layerTextGeneration(Models.summaryModel).pipe(Layer.provide(Gateway.layerProviderConfig));
    case "claude-code":
      return ClaudeCode.layer(claudeCodeModel);
    case "fake":
      return Fake.layerTextGeneration(SummarizeFake.respond);
  }
};

const embeddingsLayer = (provider: EmbeddingsProvider) =>
  provider === "gateway"
    ? Gateway.layerEmbeddings(Models.embeddingModel).pipe(Layer.provide(Gateway.layerProviderConfig))
    : Fake.layerEmbeddings();

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { mode, ci, text, embeddings, claudeCodeModel } = yield* settings;
    yield* requireLocal(text, mode, ci);
    yield* requireLocal(embeddings, mode, ci);
    return Layer.merge(textLayer(text, claudeCodeModel), embeddingsLayer(embeddings));
  }),
);
