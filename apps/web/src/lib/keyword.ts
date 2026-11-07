import type { Match } from "@stargrep/ui";

const stopwords = new Set([
  "a",
  "an",
  "and",
  "by",
  "for",
  "from",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export const normalize = (query: string) => query.trim().replace(/\s+/g, " ").toLowerCase();

export const keywordTerms = (query: string) => {
  const words = normalize(query)
    .split(" ")
    .filter((word) => word !== "");
  return words.length > 1 ? words.filter((word) => !stopwords.has(word)) : words;
};

const containsAll = (terms: ReadonlyArray<string>) => (entry: { readonly text: string }) =>
  terms.every((term) => entry.text.includes(term));

export const matchesEvery = <E extends { readonly text: string }>(
  entries: ReadonlyArray<E>,
  terms: ReadonlyArray<string>,
) => (terms.length === 0 ? [] : entries.filter(containsAll(terms)));

export const anyMatches = (entries: ReadonlyArray<{ readonly text: string }>, terms: ReadonlyArray<string>) =>
  entries.some(containsAll(terms));

export interface Searchable {
  readonly owner: string;
  readonly name: string;
  readonly description: string | null;
  readonly summary: string | null;
  readonly language: string | null;
  readonly topics: ReadonlyArray<string>;
  readonly keywords: ReadonlyArray<string>;
}

export const searchText = (repo: Searchable) =>
  [repo.owner, repo.name, repo.description, repo.summary, repo.language, ...repo.topics, ...repo.keywords]
    .filter((part) => part !== null && part !== "")
    .join(" ")
    .toLowerCase();

const termScore = (term: string, name: string, owner: string, topics: ReadonlyArray<string>) => {
  if (name === term) return 100;
  if (name.startsWith(term)) return 50;
  if (name.includes(term)) return 25;
  if (owner.includes(term)) return 10;
  return topics.includes(term) ? 8 : 0;
};

export const score = (repo: Searchable, terms: ReadonlyArray<string>) => {
  const name = repo.name.toLowerCase();
  const owner = repo.owner.toLowerCase();
  const topics = repo.topics.map((topic) => topic.toLowerCase());
  const phrase = terms.join(" ");
  const exact = name === phrase || `${owner}/${name}` === phrase ? 1000 : 0;
  return terms.reduce((total, term) => total + termScore(term, name, owner, topics), exact);
};

// A letter outside the Basic Multilingual Plane spans two UTF-16 units, and a combining mark belongs to the letter
// before it, so both continue a word.
const endsWord = /[\p{L}\p{M}\p{N}]$/u;
const startsWord = /^[\p{L}\p{M}\p{N}]/u;

const wordBefore = (text: string, at: number) => endsWord.test(text.slice(Math.max(0, at - 2), at));
const wordAfter = (text: string, at: number) => startsWord.test(text.slice(at, at + 2));

// A mark explains the match, so it starts a word: "ai" in "jailbreaking" would read as noise. A term of two letters or
// fewer also has to end the word, or "ai" would mark "aims".
export const highlights = (text: string, terms: ReadonlyArray<string>): Array<Match> => {
  const lower = text.toLowerCase();
  return terms.flatMap((term) => {
    const found: Array<Match> = [];
    const whole = [...term].length <= 2;
    for (let at = lower.indexOf(term); at >= 0 && term !== ""; at = lower.indexOf(term, at + 1)) {
      const end = at + term.length;
      if (wordAfter(term, 0) && wordBefore(lower, at)) continue;
      if (whole && wordAfter(lower, end)) continue;
      found.push([at, end]);
      at = end - 1;
    }
    return found;
  });
};
