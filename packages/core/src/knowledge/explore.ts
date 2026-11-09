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
  ["edge", ["edge-browser"]],
]);

// Topics whose display name names the topic though it does not spell the slug, as AT Protocol does atproto, reviewed by
// hand. Every other such display name goes unused, because Explore often drops the disambiguator its slug carries.
const namedByLabel: ReadonlySet<string> = new Set([
  "3ds-homebrew",
  "agentic-ai",
  "altv",
  "asyncapi",
  "atproto",
  "awesome",
  "azd-templates",
  "bcsamples",
  "bluesky-social",
  "capnproto",
  "cassandra",
  "chacha-cipher",
  "chapel",
  "clab-topo",
  "classless",
  "computercraft-tweaked",
  "coverage",
  "cpp",
  "craftstudio",
  "creative-commons",
  "csharp",
  "dotenv",
  "dotnet",
  "dragonruby",
  "dsh",
  "dsh-plugin",
  "dwd",
  "eksisozluk",
  "eloquent",
  "fish",
  "fluent-design",
  "fsharp",
  "fuzzing",
  "gamemaker",
  "garrysmod",
  "geneontology",
  "gh-extension",
  "golem",
  "google-cloud",
  "gpl",
  "json-api",
  "julia",
  "libcloud",
  "love2d",
  "mahapps",
  "mathcomp",
  "mount-and-blade-bannerlord",
  "nasa-pace",
  "nashville",
  "noaa-nsap",
  "obsidian-md",
  "oorexx",
  "open-graph",
  "openapi",
  "orm",
  "playdate",
  "playdate-sdk",
  "pmmp",
  "powertoys",
  "psr-11",
  "psr-15",
  "psr-4",
  "psr-7",
  "pubsub",
  "pulsar",
  "recon",
  "scpsl-labapi",
  "spark",
  "squeak",
  "ss13",
  "suckless",
  "swift-vapor",
  "tailwind",
  "thedreamlab",
  "tldr",
  "touhou",
  "tui",
  "ui-design",
  "unipi",
  "unist",
  "university-of-texas-arlington",
  "utility",
  "vanilla-js",
  "vertx",
  "vlc-media-player",
  "vm-box",
  "vut",
  "wsl",
  "xk6",
  "xsoar",
  "yii",
]);

// Labels for topics whose display name drops the slug's disambiguator, as Argo does argo-floats, or names more than the
// topic, as "Edge Computing & AIoT" does. Each one spells its slug.
const relabeled: ReadonlyMap<string, string> = new Map([
  ["amphp", "AMPHP"],
  ["argo-floats", "Argo floats"],
  ["bonsai-rx", "Bonsai-Rx"],
  ["data-load-tool", "Data load tool"],
  ["edge-computing", "Edge computing"],
  ["internal-tools", "Internal tools"],
  ["m3o", "M3O"],
  ["matrix-org", "Matrix.org"],
  ["mean-stack", "MEAN stack"],
  ["mercury-lang", "Mercury lang"],
  ["nanocurrency", "Nanocurrency"],
  ["password-store", "Password store"],
  ["ponylang", "Ponylang"],
  ["riot-os", "RIOT OS"],
  ["source-engine", "Source engine"],
  ["squirrel-lang", "Squirrel lang"],
  ["casejs", "CASE.js"],
]);

// Explore aliases that a spelling rule would keep but that name something else on GitHub, as case names string-case
// and test-case tools and backbone names vision model backbones. The seed leaves them free.
const notNames: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["casejs", ["case"]],
  ["backbonejs", ["backbone"]],
]);

// Topics whose own slug means something broader on GitHub, given a key and label of their own, as edge means edge
// runtimes more than the browser. The slug stays free.
const rekeyed: ReadonlyMap<string, { readonly key: string; readonly label: string }> = new Map([
  ["edge", { key: "microsoft-edge", label: "Microsoft Edge" }],
]);

export const exploreEntries = (file: ExploreFile): ReadonlyArray<SeedEntry> =>
  file.topics.map((topic) => {
    const synonyms = reviewed.get(topic.topic) ?? [];
    const unnamed = notNames.get(topic.topic) ?? [];
    const rekey = rekeyed.get(topic.topic);
    return {
      key: rekey?.key ?? topic.topic,
      label: rekey?.label ?? relabeled.get(topic.topic) ?? topic.label,
      ...(namedByLabel.has(topic.topic) ? { reviewedLabel: true } : {}),
      definition: topic.definition,
      aliases: topic.aliases.filter((alias) => !synonyms.includes(alias) && !unnamed.includes(alias)),
      synonyms: synonyms.filter((synonym) => topic.aliases.includes(synonym)),
      status: "accepted",
      reason: `GitHub explore topic ${topic.topic} (github/explore ${file.commit.slice(0, 12)}, CC-BY-4.0)`,
    };
  });
