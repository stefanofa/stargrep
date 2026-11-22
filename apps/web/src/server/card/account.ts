import type { LanguageShare } from "@stargrep/ui";
import { keywordTerms, matchesEvery, score, searchText } from "../../lib/keyword.ts";
import type { LibraryRepo, SearchResult, StarLanguages, SyncStatus } from "../../lib/rpc.ts";
import { libraryRevision } from "../../lib/sync-status.ts";

// A card has room for a line or two, so a match shows the repo's own GitHub description before Stargrep's summary.
export interface TopMatch {
  readonly owner: string;
  readonly name: string;
  readonly about: string | null;
}

// What a login's card shows. Every number is one Stargrep holds: GitHub's starred count and the imported library's
// languages. A shared search shows its query, and its best match when one costs no model work.
export interface AccountCardData {
  readonly login: string;
  readonly avatar: string | null;
  readonly stars: number | null;
  readonly languages: ReadonlyArray<LanguageShare>;
  readonly search: { readonly query: string; readonly top: TopMatch | null } | null;
}

export interface CardSource {
  readonly status: (login: string) => Promise<SyncStatus>;
  readonly library: (login: string) => Promise<ReadonlyArray<LibraryRepo>>;
  readonly languages: (login: string) => Promise<StarLanguages>;
  // The answer by meaning the API's answer cache already holds, or nothing. A card never starts a search.
  readonly cachedResults: (login: string, query: string) => Promise<ReadonlyArray<SearchResult>>;
  readonly avatar: (login: string) => Promise<string | null>;
}

const topOf = (repo: LibraryRepo | SearchResult): TopMatch => ({
  owner: repo.owner,
  name: repo.name,
  about: repo.description ?? repo.summary,
});

const keywordTop = (repos: ReadonlyArray<LibraryRepo>, query: string) => {
  const terms = keywordTerms(query);
  const entries = repos.map((repo) => ({ repo, text: searchText(repo) }));
  const [best] = matchesEvery(entries, terms).toSorted((a, b) => score(b.repo, terms) - score(a.repo, terms));
  return best === undefined ? null : topOf(best.repo);
};

// Each language's share of the whole library, as languageShares gives it, from the counts the API groups.
const sharesOf = ({ total, languages }: StarLanguages): ReadonlyArray<LanguageShare> =>
  languages.map(({ language, count }) => ({ name: language, share: count / total }));

// Reads a login's card and the library revision it describes, or null before the first import, whose revision stays
// the same while GitHub's starred count arrives. A card without a query reads its languages' counts, not the library.
// A shared search reads the library only when the answer cache has no match for it, since it shows no languages.
export const readAccountCard = async (
  { status, library, languages, cachedResults, avatar }: CardSource,
  login: string,
  q: string,
) => {
  const query = q.trim().replace(/\s+/g, " ");
  const [sync, picture, cached] = await Promise.all([
    status(login),
    avatar(login),
    query === "" ? [] : cachedResults(login, query),
  ]);
  const imported = sync.syncedAt !== null;
  const [first] = cached;
  const repos = imported && query !== "" && first === undefined ? await library(sync.login) : [];
  const card: AccountCardData = {
    login: sync.login,
    avatar: picture,
    stars: sync.starredTotal,
    languages: imported && query === "" ? sharesOf(await languages(sync.login)) : [],
    search: query === "" ? null : { query, top: first !== undefined ? topOf(first) : keywordTop(repos, query) },
  };
  return { card, revision: imported ? libraryRevision(sync) : null };
};
