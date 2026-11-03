import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

export const prompt = (repo: RepoFacts): string =>
  [
    `Repository: ${repo.fullName}`,
    `Description: ${repo.description ?? "none"}`,
    `Topics: ${repo.topics.length > 0 ? repo.topics.join(", ") : "none"}`,
    `Language: ${repo.language ?? "unknown"}`,
    "README:",
    repo.readme === null ? "none" : trimReadme(repo.readme),
  ].join("\n");

export const summarize = Effect.fn("Summarize.summarize")(function* (repo: RepoFacts) {
  const textGeneration = yield* TextGeneration.TextGeneration;
  return yield* textGeneration.generate({ schema: repoSummarySchema, system, prompt: prompt(repo) });
});

export const embeddingText = (repo: RepoFacts, summary: RepoSummary): string =>
  [repo.fullName, repo.description ?? "", summary.summary, summary.keywords.join(", ")].filter(Boolean).join("\n");
