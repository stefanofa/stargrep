import type { RepoSummary } from "./summarize.ts";

const line = (prompt: string, label: string) =>
  prompt
    .split("\n")
    .find((entry) => entry.startsWith(`${label}: `))
    ?.slice(label.length + 2) ?? "";

// The prompt writes "none" for a missing description or README, which is no part of a summary.
const given = (value: string) => (value === "none" ? "" : value);

export const respond = (prompt: string): RepoSummary => {
  const description = given(line(prompt, "Description"));
  const readme = given(prompt.split("\nREADME:\n")[1] ?? "");
  const readmeWords = readme.split(/\s+/).filter(Boolean).slice(0, 60).join(" ");
  const topics = line(prompt, "Topics");
  return {
    summary: `${description} ${readmeWords}`.trim() || line(prompt, "Repository"),
    keywords: topics === "none" ? [] : topics.split(", "),
    kind: "other",
  };
};
