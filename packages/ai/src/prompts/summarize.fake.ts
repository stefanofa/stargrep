import type { RepoSummary } from "./summarize.ts";

const line = (prompt: string, label: string) =>
  prompt
    .split("\n")
    .find((entry) => entry.startsWith(`${label}: `))
    ?.slice(label.length + 2) ?? "";

export const respond = (prompt: string): RepoSummary => {
  const description = line(prompt, "Description");
  const readme = prompt.split("\nREADME:\n")[1] ?? "";
  const readmeWords = readme.split(/\s+/).filter(Boolean).slice(0, 60).join(" ");
  const topics = line(prompt, "Topics");
  return {
    summary: `${description} ${readmeWords}`.trim() || line(prompt, "Repository"),
    keywords: topics === "none" ? [] : topics.split(", "),
    kind: "other",
  };
};
