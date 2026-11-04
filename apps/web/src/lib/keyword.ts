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

// A one-word query keeps a stopword, so typing a name letter by letter narrows on every key.
export const keywordTerms = (query: string) => {
  const words = normalize(query)
    .split(" ")
    .map((word) => word.replace(/[%_\\]/g, ""))
    .filter((word) => word !== "");
  return words.length > 1 ? words.filter((word) => !stopwords.has(word)) : words;
};

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

// Each term counts once, by the best place it matched, so a topic never outranks a name.
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

export const highlights = (text: string, terms: ReadonlyArray<string>): Array<Match> => {
  const lower = text.toLowerCase();
  return terms.flatMap((term) => {
    const found: Array<Match> = [];
    for (let at = lower.indexOf(term); at >= 0 && term !== ""; at = lower.indexOf(term, at + term.length)) {
      found.push([at, at + term.length]);
    }
    return found;
  });
};
