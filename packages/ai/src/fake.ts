import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import * as Layer from "effect/Layer";
import * as Ai from "./ai.ts";

type CallOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];

const stopwords = new Set(
  "a an and are as at be by for from has in is it its of on or that the this to with you your none unknown readme repository description topics language".split(
    " ",
  ),
);

const words = (text: string): ReadonlyArray<string> =>
  (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) ?? [])
    .map((word) => word.replace(/[.-]+$/, ""))
    .filter((word) => word.length > 1 && !stopwords.has(word));

const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const hashEmbedding = (text: string, dimensions: number): Array<number> => {
  const vector = new Array<number>(dimensions).fill(0);
  for (const word of words(text)) {
    const hash = fnv1a(word);
    vector[hash % dimensions] = (vector[hash % dimensions] ?? 0) + (hash & 0x80000000 ? -1 : 1);
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
};

const promptText = (options: CallOptions): string =>
  options.prompt
    .flatMap((message) =>
      message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
    )
    .join("\n");

const field = (text: string, name: string): string => text.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? "";

const fakeSummary = (prompt: string) => {
  const readme = prompt.split("\nREADME:\n")[1] ?? "";
  const description = field(prompt, "Description");
  const readmeWords = words(readme).slice(0, 60).join(" ");
  const counts = new Map<string, number>();
  for (const word of words(`${description} ${readme}`)) counts.set(word, (counts.get(word) ?? 0) + 1);
  const keywords = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([word]) => word);
  return { summary: `${description} ${readmeWords}`.trim() || field(prompt, "Repository"), keywords, kind: "other" };
};

const tokens = (text: string) => Math.ceil(text.length / 4);

export interface FakeOptions {
  readonly respond?: (prompt: string) => unknown;
}

export const provider = (options: FakeOptions = {}): Ai.AiProvider["Service"] => {
  const respond = options.respond ?? fakeSummary;
  return Ai.AiProvider.of({
    languageModel: (modelId) =>
      new MockLanguageModelV4({
        provider: "fake",
        modelId,
        doGenerate: async (call) => {
          const prompt = promptText(call);
          const text = JSON.stringify(respond(prompt));
          return {
            content: [{ type: "text", text }],
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: { total: tokens(prompt), noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: tokens(text), text: undefined, reasoning: undefined },
            },
            warnings: [],
          };
        },
      }),
    embeddingModel: (modelId) =>
      new MockEmbeddingModelV4({
        provider: "fake",
        modelId,
        doEmbed: async ({ values, dimensions }) => ({
          embeddings: values.map((value) => hashEmbedding(value, dimensions ?? 256)),
          usage: { tokens: values.reduce((sum, value) => sum + tokens(value), 0) },
          warnings: [],
        }),
      }),
  });
};

export const layer = (options: FakeOptions = {}) =>
  Ai.layer.pipe(Layer.provide(Layer.succeed(Ai.AiProvider, provider(options))));
