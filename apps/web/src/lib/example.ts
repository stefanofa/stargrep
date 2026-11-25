import type { Result } from "@stargrep/ui";
import { highlights, keywordTerms } from "./keyword.ts";
import { repoVisual } from "./repo-visual.ts";
import type { SearchResult } from "./rpc.ts";

export type ExampleRepo = Pick<Result, "owner" | "name" | "reason" | "matches" | "visual">;

// One person's answer to one question, which the landing shows so a visitor sees what a search finds before typing.
export interface Example {
  readonly login: string;
  readonly query: string;
  // How many stars they have, or null when stargrep has not counted them.
  readonly starred: number | null;
  // How many repos the answer holds and the first few, or null when there is no answer to show.
  readonly answer: { readonly found: number; readonly repos: ReadonlyArray<ExampleRepo> } | null;
}

export const exampleRepos = 4;

export const exampleOf = (
  { login, query, starred }: Pick<Example, "login" | "query" | "starred">,
  results: ReadonlyArray<SearchResult> | null,
): Example => {
  const terms = keywordTerms(query);
  const repos = (results ?? []).slice(0, exampleRepos).map((result): ExampleRepo => {
    const reason = result.summary ?? result.description ?? "";
    return {
      owner: result.owner,
      name: result.name,
      reason,
      matches: highlights(reason, terms),
      visual: repoVisual(result, "row"),
    };
  });
  return {
    login,
    query,
    starred,
    answer: results === null || results.length === 0 ? null : { found: results.length, repos },
  };
};
