// Judged queries for what atoms do to search: negation, contractions, only, built with, with, for, kinds, languages,
// and platforms. The recall query set has none of these shapes, so these check them on recorded repos. Each case
// compares the search with atoms to the same search without them, so the result says what the atoms changed, whatever
// the ranking. The repos each case keeps and drops come from what the query asks for.
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
  // Drops that need a subject accepted, which the usage floor does.
  readonly dropsOnceAccepted?: ReadonlyArray<string>;
}

// Terminals whose claims leave out Windows.
const terminals = ["ghostty-org/ghostty", "kovidgoyal/kitty", "wezterm/wezterm", "warpdotdev/warp"];

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
  // A platform "only" filters on the claims, and wezterm's and kitty's leave out Linux, so they drop too.
  {
    query: "terminal emulator for linux only",
    near: "ghostty-org/ghostty",
    keeps: ["ghostty-org/ghostty", "warpdotdev/warp"],
    drops: ["microsoft/terminal", "wezterm/wezterm", "kovidgoyal/kitty"],
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
  {
    query: "apps that don't run on windows",
    near: "ghostty-org/ghostty",
    keeps: terminals,
    drops: ["microsoft/terminal"],
  },
  {
    query: "apps that don’t run on windows",
    near: "ghostty-org/ghostty",
    keeps: terminals,
    drops: ["microsoft/terminal"],
  },
  {
    query: "terminals that won't run on windows",
    near: "microsoft/terminal",
    keeps: terminals,
    drops: ["microsoft/terminal"],
  },
  { query: "apps that do not support windows", near: "ghostty-org/ghostty", keeps: terminals },
  {
    query: "apps that never run on windows",
    near: "ghostty-org/ghostty",
    keeps: terminals,
    drops: ["microsoft/terminal"],
  },
  {
    query: "apps that shouldn't run on windows",
    near: "ghostty-org/ghostty",
    keeps: terminals,
    drops: ["microsoft/terminal"],
  },
  {
    query: "apps that aren't built with electron",
    near: "tw93/Pake",
    keeps: ["tw93/Pake", "tauri-apps/tauri", "flutter/flutter"],
    dropsOnceAccepted: ["atom/atom", "jgraph/drawio-desktop"],
  },
  {
    query: "cli tools built with rust",
    near: "BurntSushi/ripgrep",
    languages: ["Rust"],
    keeps: ["BurntSushi/ripgrep", "sharkdp/bat", "gitui-org/gitui"],
    drops: ["junegunn/fzf"],
  },
  {
    query: "cli tools built with go",
    near: "junegunn/fzf",
    languages: ["Go"],
    keeps: ["junegunn/fzf", "jesseduffield/lazygit"],
    drops: ["BurntSushi/ripgrep", "sharkdp/bat"],
  },
  {
    query: "cli tools built with python",
    near: "python-poetry/poetry",
    languages: ["Python"],
    keeps: ["python-poetry/poetry"],
    drops: ["astral-sh/uv"],
  },
  {
    query: "web framework without orm go",
    near: "gin-gonic/gin",
    languages: ["Go"],
    keeps: ["gin-gonic/gin", "gofiber/fiber", "labstack/echo"],
    drops: ["expressjs/express", "tokio-rs/axum", "actix/actix-web", "fastapi/fastapi"],
  },
  {
    query: "typescript orm, not javascript",
    near: "drizzle-team/drizzle-orm",
    languages: ["TypeScript", "JavaScript"],
    keeps: ["drizzle-team/drizzle-orm", "prisma/orm", "typeorm/typeorm"],
  },
  {
    query: "react libraries written in typescript not javascript",
    near: "pmndrs/zustand",
    languages: ["TypeScript", "JavaScript"],
    keeps: ["pmndrs/zustand", "pmndrs/jotai", "reduxjs/redux"],
  },
  {
    query: "llm apps with privacy",
    near: "zylon-ai/private-gpt",
    keeps: ["zylon-ai/private-gpt", "janhq/jan", "ollama/ollama", "nomic-ai/gpt4all", "open-webui/open-webui"],
  },
  {
    query: "editor with ai",
    near: "zed-industries/zed",
    keeps: ["zed-industries/zed", "microsoft/vscode", "helix-editor/helix"],
  },
  // The re-verify found these empty on prod's data, where "built on" and "powered by" tested with: atoms alone.
  {
    query: "apps built on node",
    near: "n8n-io/n8n",
    keeps: ["n8n-io/n8n"],
  },
  {
    query: "tools built with node.js",
    near: "expressjs/express",
    keeps: ["expressjs/express", "vercel/next.js"],
    drops: ["tokio-rs/axum", "actix/actix-web"],
  },
  {
    query: "chatbot powered by openai",
    near: "lobehub/lobehub",
    keeps: ["lobehub/lobehub", "langchain-ai/langchain"],
  },
  {
    query: "note app powered by ai",
    near: "logseq/logseq",
    keeps: [
      "logseq/logseq",
      "anyproto/anytype-ts",
      "AppFlowy-IO/AppFlowy",
      "laurent22/joplin",
      "siyuan-note/siyuan",
      "toeverything/AFFiNE",
      "usememos/memos",
    ],
  },
  { query: "games made with godot", near: "godotengine/godot", keeps: ["godotengine/godot"] },
  {
    query: "login with github",
    near: "nextauthjs/next-auth",
    keeps: ["nextauthjs/next-auth", "better-auth/better-auth", "keycloak/keycloak", "goauthentik/authentik"],
  },
];

// Repos that hold privacy, GitHub, and AI, which the usage floor accepts on the whole corpus. With them, the floor
// accepts those subjects on this fixture too, so the "with" cases run against accepted subjects. ruanyf/weekly is the
// one repo that states AI, which mints the subject that repos tagged ai then hold.
const floorHolders = [
  "ruanyf/weekly",
  "AdguardTeam/AdGuardHome",
  "keepassxreboot/keepassxc",
  "plausible/analytics",
  "cli/cli",
  "go-gitea/gitea",
  "trufflesecurity/trufflehog",
  "Significant-Gravitas/AutoGPT",
];

export const judgedRepos: ReadonlyArray<string> = [
  ...new Set([
    ...judged.flatMap((entry) => [
      entry.near,
      ...entry.keeps,
      ...(entry.drops ?? []),
      ...(entry.dropsOnceAccepted ?? []),
    ]),
    ...floorHolders,
  ]),
].sort();
