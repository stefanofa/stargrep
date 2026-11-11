import { DecodedFacets, decodeFacets, type PromptInput, storable } from "@stargrep/knowledge/claims";
import { extractionLines } from "@stargrep/knowledge/extraction";
import type { JSONSchema7 } from "ai";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Stream from "effect/Stream";
import type { BatchRequest } from "../batches.ts";
import type { AiSchema } from "../schema-bridge.ts";
import * as TextGeneration from "../text-generation.ts";

// A summary as the port hands it on: the text, and the facts decoded one by one against the prompt that was sent.
export const RepoSummary = Schema.Struct({
  summary: Schema.String,
  keywords: Schema.Array(Schema.String),
  facets: DecodedFacets,
});
export type RepoSummary = typeof RepoSummary.Type;

export const RepoFacts = Schema.Struct({
  fullName: Schema.String,
  description: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
  language: Schema.NullOr(Schema.String),
  readme: Schema.NullOr(Schema.String),
});
export type RepoFacts = typeof RepoFacts.Type;

export const readmeLimit = 24_000;

// A summary or keyword holding a lone surrogate or U+0000 would fail the commit that saves it, so it is made storable as
// facts are.
const ModelText = <S extends Schema.Codec<string>>(to: S) =>
  Schema.String.pipe(
    Schema.decodeTo(to, SchemaTransformation.transform({ decode: storable, encode: (text: string) => text })),
  );

// What the model returns. A failure here is an invalid answer, which counts toward the repo's failure cap, so the
// facts are left undecoded and a bad fact never fails the answer.
const Envelope = Schema.Struct({
  summary: ModelText(Schema.String.check(Schema.isMinLength(1))),
  keywords: Schema.Array(ModelText(Schema.String)),
  facets: Schema.optionalKey(Schema.Unknown),
});
type Envelope = typeof Envelope.Type;

// The schema the provider sees. It shapes the answer, but every field of a fact is a free string, with no enum, length,
// or count, so a provider that constrains decoding to it always produces output that decodes, and one that only
// validates has nothing about a fact to reject. facets is required here so constrained decoders always write it.
export const providerSchema: JSONSchema7 = {
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1 },
    keywords: { type: "array", items: { type: "string" } },
    facets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          role: { type: "string" },
          term: { type: "string" },
          quote: { type: ["string", "null"] },
        },
        required: ["role", "term"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "keywords", "facets"],
  additionalProperties: false,
};

const answerSchema: AiSchema<Envelope> = { jsonSchema: providerSchema, decode: Schema.decodeUnknownEffect(Envelope) };

// The worked example costs about 330 input tokens and saves more in output: without it the pilot's model quoted
// nearly every fact. Its comparison quote is the first entry of the Alternatives section of ratatui's README, as it
// renders. tui-rs, the crate ratatui was forked from, stays a keyword, because lineage is no alternative.
const example = {
  summary: "Ratatui is a Rust library for building rich terminal user interfaces and dashboards.",
  keywords: ["tui", "terminal ui", "tui-rs fork", "terminal dashboard", "widgets"],
  facets: [
    { role: "is", term: "library" },
    { role: "written_in", term: "Rust" },
    { role: "runs_on", term: "terminal" },
    { role: "about", term: "terminal user interfaces" },
    { role: "about", term: "dashboards" },
    { role: "alternative_to", term: "Cursive", quote: "Cursive - a ncurses-based TUI library" },
  ],
};

export const system = [
  "You describe GitHub repositories for a search index. Developers search their starred repos in plain language, so write what a developer would search for.",
  "",
  "Return JSON with these fields:",
  '- summary: two or three plain English sentences, at most 600 characters. Say what the project is, what problem it solves, and who uses it. Name the product category, such as "voice dictation app" or "terminal UI library". Write in English even when the README is in another language. Do not use marketing words. Facets do not replace the summary.',
  "- keywords: up to 12 lowercase search terms that are not already in the summary, such as synonyms, the category, and well-known products it resembles or replaces.",
  ...extractionLines(),
  "",
  "Example answer for ratatui/ratatui:",
  JSON.stringify(example, null, 2),
].join("\n");

// A summary thinks at high. In pilot 4 it was the only Haiku setting whose claims passed every precision gate but
// replaced_by, and its batch answers spent about 2,200 thinking tokens of 2,680 output. A prefill trial may ask for
// another level, and its stored requests record it.
export const reasoning: TextGeneration.Reasoning = "high";

export const trimReadme = (readme: string): string =>
  readme.length <= readmeLimit ? readme : `${readme.slice(0, readmeLimit)}\n[README truncated]`;

const htmlTagNames =
  "a|abbr|b|blockquote|br|center|code|dd|del|details|div|dl|dt|em|figcaption|figure|font|g|h[1-6]|hr|i|img|ins|kbd|li|ol|p|path|picture|pre|s|section|small|source|span|strong|sub|summary|sup|svg|table|tbody|td|tfoot|th|thead|tr|tt|u|ul|video";

const imageLinks = /!\[[^[\]\n]*\](?:\([^()\n]*\)|\[[^[\]\n]*\])?/g;
const emptyLinks = /\[[ \t]*\](?:\([^()\n]*\)|\[[^[\]\n]*\])/g;
const linkDefinitions = /^[ \t]*\[[^[\]\n]+\]:[ \t]*\S.*$/gm;
const htmlTags = new RegExp(`</?(?:${htmlTagNames})(?=[\\s/>])[^<>]*>`, "g");
const emailAutolinks = /<([^<>\s@]+@[^<>\s@]+)>/g;
const inlineCode = /(`[^`\n]+`)/;
const fenceOpening = /^ {0,3}(`{3,}|~{3,})/;
const blankRuns = /\n[ \t]*(\n[ \t]*)+/g;
const trailingSpace = /[ \t]+$/gm;
const wordCharacter = /[\p{L}\p{N}]/u;
const replacementCharacters = /�/g;
const binaryShare = 0.01;

const withoutComments = (text: string) => {
  const kept: Array<string> = [];
  let at = 0;
  for (let open = text.indexOf("<!--"); open !== -1; open = text.indexOf("<!--", at)) {
    const close = text.indexOf("-->", open + 4);
    if (close === -1) break;
    kept.push(text.slice(at, open));
    at = close + 3;
  }
  kept.push(text.slice(at));
  return kept.join("");
};

const cleanProse = (prose: string) =>
  withoutComments(prose)
    .split(inlineCode)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(imageLinks, "")
            .replace(emptyLinks, "")
            .replace(linkDefinitions, "")
            .replace(htmlTags, "")
            .replace(emailAutolinks, "$1"),
    )
    .join("");

const isBinary = (readme: string) =>
  readme.includes("\u0000") || (readme.match(replacementCharacters)?.length ?? 0) > readme.length * binaryShare;

export const readmeText = (readme: string): string | null => {
  if (isBinary(readme)) return null;
  const blocks: Array<string> = [];
  let prose: Array<string> = [];
  let fence: string | null = null;
  for (const line of readme.replace(replacementCharacters, "").split("\n")) {
    if (fence !== null) {
      blocks.push(line);
      if (line.trimStart().startsWith(fence) && line.trim().replaceAll(fence[0] ?? "", "") === "") fence = null;
      continue;
    }
    const opening = fenceOpening.exec(line)?.[1];
    if (opening === undefined) {
      prose.push(line);
      continue;
    }
    blocks.push(cleanProse(prose.join("\n")), line);
    prose = [];
    fence = opening;
  }
  blocks.push(cleanProse(prose.join("\n")));
  const text = blocks.join("\n").replace(trailingSpace, "").replace(blankRuns, "\n\n").trim();
  return wordCharacter.test(text) ? text : null;
};

// A prompt and the evidence it carried, built from one cleaned README, so every quote and term is matched against the
// exact text the model saw.
export interface Prompted {
  readonly text: string;
  readonly input: PromptInput;
}

export const promptOf = (repo: RepoFacts): Prompted => {
  const cleaned = repo.readme === null ? null : readmeText(repo.readme);
  const readme = cleaned === null ? null : trimReadme(cleaned);
  return {
    text: [
      `Repository: ${repo.fullName}`,
      `Description: ${repo.description ?? "none"}`,
      `Topics: ${repo.topics.length > 0 ? repo.topics.join(", ") : "none"}`,
      `Language: ${repo.language ?? "unknown"}`,
      "README:",
      readme ?? "none",
    ].join("\n"),
    input: { fullName: repo.fullName, description: repo.description ?? "", topics: repo.topics, readme: readme ?? "" },
  };
};

const answer = (input: PromptInput, envelope: Envelope): RepoSummary => ({
  summary: envelope.summary,
  keywords: envelope.keywords,
  facets: decodeFacets(envelope.facets, input),
});

// One direct call for a prompt already built, such as one a provider batch did not answer.
export const summarizePrompted = Effect.fnUntraced(function* (
  { text, input }: Prompted,
  level: TextGeneration.Reasoning = reasoning,
) {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const envelope = yield* textGeneration.generate({ schema: answerSchema, system, prompt: text, reasoning: level });
  return answer(input, envelope);
});

export const summarize = (repo: RepoFacts) => summarizePrompted(promptOf(repo));

// The provider batch request for these prompts, in order, as the prefill stores and sends it.
export const batchRequest = (
  model: string,
  prompts: ReadonlyArray<Prompted>,
  level: TextGeneration.Reasoning = reasoning,
): BatchRequest => ({
  model,
  system,
  jsonSchema: providerSchema,
  prompts: prompts.map((prompt) => prompt.text),
  reasoning: level,
});

// A raw batch answer decoded against the prompt it answers. A SchemaError means the answer is invalid as a whole.
export const answerOf = (input: PromptInput, output: unknown) =>
  Effect.map(answerSchema.decode(output), (envelope) => answer(input, envelope));

export const summarizeBatch = <I>(items: ReadonlyArray<I>, facts: (item: I) => RepoFacts) =>
  Stream.unwrap(
    Effect.map(TextGeneration.TextGeneration, (textGeneration) => {
      const prompted = items.map((item) => ({ item, prompt: promptOf(facts(item)) }));
      return textGeneration
        .generateBatch({
          schema: answerSchema,
          system,
          reasoning,
          items: prompted,
          prompt: ({ prompt }) => prompt.text,
        })
        .pipe(
          Stream.map(
            ([{ item, prompt }, result]): TextGeneration.BatchAnswer<RepoSummary, I> => [
              item,
              Result.map(result, (envelope) => answer(prompt.input, envelope)),
            ],
          ),
        );
    }),
  );

export const embeddingText = (
  repo: Pick<RepoFacts, "fullName" | "description">,
  summary: Pick<RepoSummary, "summary" | "keywords">,
): string =>
  [repo.fullName, repo.description ?? "", summary.summary, summary.keywords.join(", ")].filter(Boolean).join("\n");
