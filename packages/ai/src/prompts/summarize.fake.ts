import { type LabelKey, labelKey } from "@stargrep/knowledge/label-key";
import { type ClosedValue, closedKeys, kinds, platforms } from "@stargrep/knowledge/registry";

// One fact as the model writes it, before the port decodes it.
export interface Fact {
  readonly role: string;
  readonly term: string;
  readonly quote?: string;
}

// An answer as the provider returns it, before the port decodes it.
export interface Answer {
  readonly summary: string;
  readonly keywords: ReadonlyArray<string>;
  readonly facets: ReadonlyArray<Fact>;
}

const line = (prompt: string, label: string) =>
  prompt
    .split("\n")
    .find((entry) => entry.startsWith(`${label}: `))
    ?.slice(label.length + 2) ?? "";

// The prompt writes "none" for a missing description or README, which is no part of a summary.
const given = (value: string) => (value === "none" ? "" : value);

const spellingsOf = (values: ReadonlyArray<ClosedValue<string>>) =>
  new Map<LabelKey, string>(values.flatMap((entry) => closedKeys(entry).map((key) => [key, entry.id] as const)));
const kindSpellings = spellingsOf(kinds);
const platformSpellings = spellingsOf(platforms);

const maxPhraseWords = 3;

// The phrases of up to three words in the text that spell a closed value, once per value, in the order they appear.
const spelled = (text: string, spellings: ReadonlyMap<LabelKey, string>): ReadonlyArray<string> => {
  const words = text.split(/\s+/).map((word) => word.replace(/^[^\p{L}\p{N}.]+|[^\p{L}\p{N}+#]+$/gu, ""));
  const seen = new Set<string>();
  const found: Array<string> = [];
  words.forEach((_, start) => {
    for (let size = maxPhraseWords; size >= 1; size--) {
      const phrase = words.slice(start, start + size).join(" ");
      const key = labelKey(phrase);
      const value = key === null ? undefined : spellings.get(key);
      if (value === undefined || seen.has(value)) continue;
      seen.add(value);
      found.push(phrase);
      return;
    }
  });
  return found;
};

const alternativeTo = /\balternative to (\p{L}[\p{L}\p{N}.+#-]*(?: \p{Lu}[\p{L}\p{N}.+#-]*){0,2})/gu;
const namedAlternative = /\b(\p{Lu}[\p{L}\p{N}.+#-]*) alternative\b/gu;
const articles = new Set(["A", "An", "The"]);

const alternatives = (description: string): ReadonlyArray<Fact> => [
  ...[...description.matchAll(alternativeTo)].map(([quote, term = ""]) => ({ role: "alternative_to", term, quote })),
  ...[...description.matchAll(namedAlternative)]
    .filter(([, term = ""]) => !articles.has(term))
    .map(([quote, term = ""]) => ({ role: "alternative_to", term, quote })),
];

const maxQuote = 200;
const readmeLinesRead = 5;

// A deprecation the description or the start of the README states, quoted from the line that says it.
const deprecation = (description: string, readme: string): ReadonlyArray<Fact> => {
  const lines = [
    description,
    ...readme
      .split("\n")
      .filter((entry) => entry.trim() !== "")
      .slice(0, readmeLinesRead),
  ];
  const stated = lines.find((entry) => /\bdeprecated\b/i.test(entry))?.trim();
  if (stated === undefined) return [];
  return [{ role: "status", term: "deprecated", quote: stated.length <= maxQuote ? stated : "deprecated" }];
};

// The stand-in summary model. It reads the rendered prompt by line label and states only what that text shows: the
// kind and platform words of the description, the language, each topic as a subject, a named alternative, and a stated
// deprecation. It never guesses a kind, so a repo whose description names none has none, as a real one can.
export const respond = (prompt: string): Answer => {
  const description = given(line(prompt, "Description"));
  const readme = given(prompt.split("\nREADME:\n")[1] ?? "");
  const readmeWords = readme.split(/\s+/).filter(Boolean).slice(0, 60).join(" ");
  const topicLine = line(prompt, "Topics");
  const topics = topicLine === "none" || topicLine === "" ? [] : topicLine.split(", ");
  const language = line(prompt, "Language");
  return {
    summary: `${description} ${readmeWords}`.trim() || line(prompt, "Repository"),
    keywords: topics,
    facets: [
      ...spelled(description, kindSpellings).map((term) => ({ role: "is", term })),
      ...(language === "unknown" || language === "" ? [] : [{ role: "written_in", term: language }]),
      ...spelled(description, platformSpellings).map((term) => ({ role: "runs_on", term })),
      ...topics.map((topic) => ({ role: "about", term: topic, quote: topic })),
      ...alternatives(description),
      ...deprecation(description, readme),
    ],
  };
};
