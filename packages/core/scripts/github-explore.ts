import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { labelKey } from "@stargrep/knowledge/label-key";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Front = Schema.Struct({
  topic: Schema.optionalKey(Schema.Unknown),
  display_name: Schema.optionalKey(Schema.Unknown),
  short_description: Schema.optionalKey(Schema.Unknown),
  aliases: Schema.optionalKey(Schema.Unknown),
});
type Front = typeof Front.Type;
const decodeFront = Schema.decodeUnknownSync(Front);

// A few front matters hold YAML that Bun's parser refuses, such as a quoted value broken across lines with no indent.
// Those fall back to reading the four fields this needs, one line each.
const parseFront = (yaml: string): Front => {
  try {
    return decodeFront(Bun.YAML.parse(yaml));
  } catch {
    const fields = new Map<string, string>();
    for (const line of yaml.split("\n")) {
      const field = /^(topic|display_name|short_description|aliases):\s*(.*)$/.exec(line);
      if (field?.[1] !== undefined && field[2] !== undefined) fields.set(field[1], field[2]);
    }
    return decodeFront(Object.fromEntries(fields));
  }
};

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

// subjects.label and subjects.definition hold at most 120 and 400 characters. A longer one is cut at a word and marked.
// A display name's "(disambiguation)" suffix, which Explore copies from Wikipedia, is dropped.
const fit = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 1);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
};

const topicOf = (text: string) => {
  const match = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n?/g, "\n"));
  if (match?.[1] === undefined) return [];
  const front = parseFront(match[1]);
  if (front.topic === undefined) return [];
  const topic = String(front.topic);
  return [
    {
      topic,
      label: fit(oneLine(String(front.display_name ?? topic)).replace(/\s*\(disambiguation\)$/i, ""), 120),
      definition: fit(oneLine(String(front.short_description ?? "")), 400),
      aliases: String(front.aliases ?? "")
        .split(",")
        .map((alias) => alias.trim())
        .filter((alias) => alias !== "" && labelKey(alias) !== null),
    },
  ];
};

const seedFile = (commit: string, topics: ReadonlyArray<ReturnType<typeof topicOf>[number]>) =>
  `${JSON.stringify(
    {
      source: "https://github.com/github/explore",
      commit,
      license: "CC-BY-4.0 https://creativecommons.org/licenses/by/4.0/",
      attribution:
        "Topic names, display names, aliases, and short descriptions from GitHub Explore (github/explore) by GitHub, Inc. and contributors, under CC-BY-4.0. Changed: descriptions joined onto one line and cut at 400 characters, labels cut at 120, and a display name's (disambiguation) suffix dropped.",
      topics,
    },
    null,
    1,
  )}\n`;

const readTopics = async (checkout: string) => {
  const found = [];
  for await (const path of new Bun.Glob("topics/*/index.md").scan(checkout)) {
    found.push(...topicOf(await Bun.file(`${checkout}/${path}`).text()));
  }
  return found.sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
};

const generate = Command.make(
  "github-explore",
  {
    checkout: Argument.Directory("checkout").pipe(Argument.withDescription("A checkout of github/explore")),
    commit: Argument.String("commit").pipe(Argument.withDescription("The checkout's commit, recorded with the seeds")),
  },
  Effect.fn("githubExplore")(function* ({ checkout, commit }) {
    const topics = yield* Effect.promise(() => readTopics(checkout));
    yield* Effect.promise(() => Bun.write(`${import.meta.dir}/../seeds/github-explore.json`, seedFile(commit, topics)));
    yield* Console.log(`${topics.length} topics from ${commit}`);
  }),
).pipe(Command.withDescription("Write seeds/github-explore.json from a checkout of github/explore"));

generate.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
