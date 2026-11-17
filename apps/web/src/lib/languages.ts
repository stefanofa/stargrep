import type { LanguageShare } from "@stargrep/ui";

// Each language's share of a library, largest first. A repo GitHub names no language for counts toward the whole.
export const languageShares = (
  repos: ReadonlyArray<{ readonly language: string | null }>,
): ReadonlyArray<LanguageShare> => {
  const counts = new Map<string, number>();
  for (const repo of repos) if (repo.language !== null) counts.set(repo.language, (counts.get(repo.language) ?? 0) + 1);
  return Array.from(counts, ([name, count]) => ({ name, share: count / repos.length })).toSorted(
    (a, b) => b.share - a.share,
  );
};
