// Judged queries for what atoms do to search: negation, only, built with, for, kinds, and platforms. The recall query
// set has no negation and no "only", so these check those paths on recorded repos. Each case compares the search with
// atoms to the same search without them, so the result says what the atoms changed, whatever the ranking.
export interface Judged {
  readonly query: string;
  // The repo whose recorded vector stands in for the query's, since no query embedding may be bought.
  readonly near: string;
  // What a guarded plan would hold. A language is said as its name in lowercase, which the query must contain.
  readonly languages?: ReadonlyArray<string>;
  readonly kinds?: ReadonlyArray<"app" | "library" | "framework" | "cli" | "plugin" | "list">;
  // Repos the search without atoms finds, which the atoms must keep.
  readonly keeps: ReadonlyArray<string>;
  // Repos the search without atoms finds, which the atoms must drop.
  readonly drops?: ReadonlyArray<string>;
  // Drops that need a subject accepted, which no subject is in prod until curation accepts one.
  readonly dropsOnceAccepted?: ReadonlyArray<string>;
}

const desktopApps = [
  "tw93/Pake",
  "jgraph/drawio-desktop",
  "rancher-sandbox/rancher-desktop",
  "beekeeper-studio/beekeeper-studio",
];

export const judged: ReadonlyArray<Judged> = [
  {
    query: "no-code app builder",
    near: "langgenius/dify",
    keeps: ["langgenius/dify", "langflow-ai/langflow", "n8n-io/n8n", "activepieces/activepieces", "FlowiseAI/Flowise"],
  },
  { query: "no-code apps", near: "n8n-io/n8n", keeps: ["n8n-io/n8n", "langgenius/dify", "activepieces/activepieces"] },
  {
    query: "non-electron desktop apps",
    near: "tw93/Pake",
    keeps: ["tw93/Pake", "rancher-sandbox/rancher-desktop", "jgraph/drawio-desktop", "atom/atom"],
  },
  { query: "without electron desktop apps", near: "beekeeper-studio/beekeeper-studio", keeps: desktopApps },
  {
    query: "no dependency cli tool",
    near: "BurntSushi/ripgrep",
    keeps: ["BurntSushi/ripgrep", "junegunn/fzf", "sharkdp/bat", "mikefarah/yq"],
  },
  {
    query: "no-std rust libraries",
    near: "clap-rs/clap",
    languages: ["Rust"],
    keeps: ["clap-rs/clap"],
  },
  {
    query: "terminal emulator for linux only",
    near: "ghostty-org/ghostty",
    keeps: ["ghostty-org/ghostty", "warpdotdev/warp"],
    drops: ["microsoft/terminal"],
  },
  {
    query: "configuration management tool, not puppet",
    near: "ansible/ansible",
    keeps: ["ansible/ansible", "hashicorp/terraform", "pulumi/pulumi"],
  },
  {
    query: "tools for training models that do not need a gpu",
    near: "unslothai/unsloth",
    keeps: ["unslothai/unsloth", "ggml-org/llama.cpp"],
  },
  {
    query: "only cli tools for macos",
    near: "sharkdp/bat",
    kinds: ["cli"],
    keeps: ["sharkdp/bat", "junegunn/fzf", "BurntSushi/ripgrep"],
    drops: ["warpdotdev/warp"],
  },
  {
    query: "cli tools for macos",
    near: "sharkdp/bat",
    keeps: ["sharkdp/bat", "junegunn/fzf", "BurntSushi/ripgrep", "warpdotdev/warp"],
  },
  {
    query: "only libraries for building apps",
    near: "flutter/flutter",
    kinds: ["library"],
    keeps: ["flutter/flutter"],
    drops: ["electron/electron", "tauri-apps/tauri"],
  },
  {
    query: "only rust libraries",
    near: "ratatui/ratatui",
    languages: ["Rust"],
    kinds: ["library"],
    keeps: ["ratatui/ratatui", "clap-rs/clap"],
    drops: ["tauri-apps/tauri"],
  },
  {
    query: "javascript charting library",
    near: "d3/d3",
    languages: ["JavaScript"],
    keeps: ["d3/d3"],
  },
  {
    query: "apps built with electron",
    near: "atom/atom",
    keeps: ["atom/atom", "microsoft/vscode", "jgraph/drawio-desktop"],
    dropsOnceAccepted: ["tw93/Pake", "tauri-apps/tauri"],
  },
  {
    query: "apps not built with electron",
    near: "tw93/Pake",
    keeps: ["tw93/Pake", "tauri-apps/tauri", "flutter/flutter"],
    dropsOnceAccepted: ["atom/atom", "rancher-sandbox/rancher-desktop", "jgraph/drawio-desktop"],
  },
  {
    query: "apps that do not run on windows",
    near: "ghostty-org/ghostty",
    keeps: ["ghostty-org/ghostty", "warpdotdev/warp"],
    drops: ["rancher-sandbox/rancher-desktop", "microsoft/terminal"],
  },
  {
    query: "terminals that do not run on windows",
    near: "microsoft/terminal",
    keeps: ["ghostty-org/ghostty", "warpdotdev/warp"],
    drops: ["microsoft/terminal", "microsoft/vscode"],
  },
];

export const judgedRepos: ReadonlyArray<string> = [
  ...new Set(
    judged.flatMap((entry) => [entry.near, ...entry.keeps, ...(entry.drops ?? []), ...(entry.dropsOnceAccepted ?? [])]),
  ),
].sort();
