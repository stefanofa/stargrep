import type { SeedEntry } from "@stargrep/knowledge/seeds";
import * as Schema from "effect/Schema";

// seeds/github-explore.json, which scripts/github-explore.ts writes from a checkout of github/explore.
export const ExploreFile = Schema.Struct({
  commit: Schema.String,
  topics: Schema.Array(
    Schema.Struct({
      topic: Schema.String,
      label: Schema.String,
      definition: Schema.String,
      aliases: Schema.Array(Schema.String),
    }),
  ),
});
export type ExploreFile = typeof ExploreFile.Type;

// Explore aliases that name the topic itself without spelling it, reviewed by hand. The seed keeps them as synonyms.
// Every other alias is kept only when it spells the topic or its label another way.
const reviewed: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["postgresql", ["postgres", "pgsql"]],
  ["kubernetes", ["k8s"]],
  ["visual-studio-code", ["vscode"]],
  ["yaml", ["yml"]],
  ["neovim", ["nvim"]],
  ["scikit-learn", ["sklearn"]],
  ["mongodb", ["mongo"]],
  ["sass", ["scss"]],
  ["unreal-engine", ["ue4"]],
  ["unity", ["unity3d"]],
  ["godot", ["godot-engine", "godotengine"]],
  ["redis", ["redisdb", "redis-db"]],
  ["discord", ["discordapp"]],
]);

export const exploreEntries = (file: ExploreFile): ReadonlyArray<SeedEntry> =>
  file.topics.map((topic) => {
    const synonyms = reviewed.get(topic.topic) ?? [];
    return {
      key: topic.topic,
      label: topic.label,
      definition: topic.definition,
      aliases: topic.aliases.filter((alias) => !synonyms.includes(alias)),
      synonyms: synonyms.filter((synonym) => topic.aliases.includes(synonym)),
      status: "accepted",
      reason: `GitHub explore topic ${topic.topic} (github/explore ${file.commit.slice(0, 12)}, CC-BY-4.0)`,
    };
  });
