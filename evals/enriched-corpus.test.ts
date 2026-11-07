import { expect, test } from "bun:test";
import type { RepoFacts } from "@stargrep/ai/summarize";
import { summaryFingerprint } from "./enriched-corpus.ts";

const repo: RepoFacts = {
  fullName: "owner/repo",
  description: "description",
  topics: ["cli"],
  language: "Rust",
  readme: "README",
};

test("summary identity is independent of object key insertion order", () => {
  expect(
    summaryFingerprint({
      readme: repo.readme,
      language: repo.language,
      topics: repo.topics,
      description: repo.description,
      fullName: repo.fullName,
    }),
  ).toBe(summaryFingerprint(repo));
});

test("each repository fact invalidates a cached summary", () => {
  for (const changed of [
    { ...repo, fullName: "owner/renamed" },
    { ...repo, description: null },
    { ...repo, topics: ["library"] },
    { ...repo, language: null },
    { ...repo, readme: "new README" },
  ])
    expect(summaryFingerprint(changed)).not.toBe(summaryFingerprint(repo));
});
