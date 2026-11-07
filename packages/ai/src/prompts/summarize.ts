import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { toAiSchema } from "../schema-bridge.ts";
import * as TextGeneration from "../text-generation.ts";

export const RepoKind = Schema.Literals([
  "app",
  "library",
  "framework",
  "cli",
  "plugin",
  "template",
  "list",
  "learning",
  "dataset",
  "model",
  "config",
  "other",
]);
export type RepoKind = typeof RepoKind.Type;

export const RepoSummary = Schema.Struct({
  summary: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  keywords: Schema.Array(Schema.String),
  kind: RepoKind,
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

const repoSummarySchema = toAiSchema(RepoSummary);

export const system = `You describe GitHub repositories for a search index. Developers search their starred repos in plain language, so write what a developer would search for.

Return JSON with these fields:
- summary: two or three plain English sentences, at most 600 characters. Say what the project is, what problem it solves, and who uses it. Name the product category, such as "voice dictation app" or "terminal UI library". Write in English even when the README is in another language. Do not use marketing words.
- keywords: up to 12 lowercase search terms that are not already in the summary, such as synonyms, the category, and well-known products it resembles or replaces.
- kind: one of app (an end-user application or service), library, framework, cli, plugin (an extension for another tool), template (a starter or boilerplate), list (an awesome list or link collection), learning (a tutorial, course, book, or examples), dataset, model (machine learning weights), config (dotfiles or configuration), other.`;

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

const readmeSection = (readme: string | null) => {
  const text = readme === null ? null : readmeText(readme);
  return text === null ? "none" : trimReadme(text);
};

export const prompt = (repo: RepoFacts): string =>
  [
    `Repository: ${repo.fullName}`,
    `Description: ${repo.description ?? "none"}`,
    `Topics: ${repo.topics.length > 0 ? repo.topics.join(", ") : "none"}`,
    `Language: ${repo.language ?? "unknown"}`,
    "README:",
    readmeSection(repo.readme),
  ].join("\n");

export const summarize = Effect.fnUntraced(function* (repo: RepoFacts) {
  const textGeneration = yield* TextGeneration.TextGeneration;
  return yield* textGeneration.generate({ schema: repoSummarySchema, system, prompt: prompt(repo) });
});

export const summarizeBatch = <I>(items: ReadonlyArray<I>, facts: (item: I) => RepoFacts) =>
  Stream.unwrap(
    Effect.map(TextGeneration.TextGeneration, (textGeneration) =>
      textGeneration.generateBatch({ schema: repoSummarySchema, system, items, prompt: (item) => prompt(facts(item)) }),
    ),
  );

export const embeddingText = (
  repo: Pick<RepoFacts, "fullName" | "description">,
  summary: Pick<RepoSummary, "summary" | "keywords">,
): string =>
  [repo.fullName, repo.description ?? "", summary.summary, summary.keywords.join(", ")].filter(Boolean).join("\n");
