import type { Match, Person, RepoDetail, Result, StarredWeek } from "../src/index.ts";

const marks = (text: string, ...words: string[]): Match[] =>
  words.map((word) => {
    const start = text.indexOf(word);
    return [start, start + word.length];
  });

const people = {
  lena: { login: "lena" },
  kofi: { login: "kofi" },
  jprd: { login: "jprd" },
  mtsk: { login: "mtsk" },
} satisfies Record<string, Person>;

const svg = (body: string, size = 64) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${body}</svg>`)}`;

export const icons = {
  ratatui: svg('<rect width="64" height="64" fill="#fff"/><path d="M14 46 30 14l6 14 14-6-10 24z" fill="#1e1b2e"/>'),
  console: svg(
    '<circle cx="32" cy="32" r="20" fill="none" stroke="#1e1b2e" stroke-width="4"/><path d="M32 4v12M32 48v12M4 32h12M48 32h12" stroke="#1e1b2e" stroke-width="4"/>',
  ),
  ghost: svg(
    '<path d="M16 54V28a16 16 0 0 1 32 0v26l-6-5-5 5-5-5-5 5-5-5z" fill="#fff"/><circle cx="26" cy="30" r="3" fill="#1e1b2e"/><circle cx="38" cy="30" r="3" fill="#1e1b2e"/>',
  ),
  favicon: svg(
    '<rect width="64" height="64" rx="14" fill="#2bb673"/><path d="M18 34l10 10 18-22" stroke="#fff" stroke-width="7" fill="none"/>',
    16,
  ),
};

const result = (
  owner: string,
  name: string,
  reason: string,
  words: string[],
  rest: Pick<Result, "activity" | "stars" | "starred" | "network"> &
    Partial<Pick<Result, "visual" | "language" | "unread">>,
): Result => ({
  owner,
  name,
  href: `?repo=${owner}/${name}`,
  reason,
  matches: marks(reason, ...words),
  visual: { kind: "monogram", letters: owner.slice(0, 2).toLowerCase() },
  language: "Rust",
  unread: false,
  ...rest,
});

const ratatuiReason = "Widgets for charts, gauges, sparklines, and tables. The maintained fork of tui-rs.";

export const results: Result[] = [
  result("ratatui", "ratatui", ratatuiReason, ["charts, gauges, sparklines", "tui-rs"], {
    activity: { state: "alive", label: "pushed 2 days ago" },
    stars: 16_400,
    starred: "Mar 14, 2025",
    network: [people.lena, people.kofi, people.jprd, people.mtsk],
    visual: { kind: "icon", url: icons.ratatui, plate: "light", size: 128, letters: "ra" },
  }),
  result(
    "ClementTsang",
    "bottom",
    "A system monitor dashboard for the terminal, built on ratatui.",
    ["dashboard", "terminal"],
    {
      activity: { state: "alive", label: "pushed last week" },
      stars: 11_600,
      starred: "Aug 2, 2025",
      network: [people.kofi, people.mtsk],
      visual: { kind: "avatar", url: "https://github.com/ClementTsang.png?size=88", letters: "cl" },
    },
  ),
  result(
    "tokio-rs",
    "console",
    "A live terminal dashboard of the async tasks in a Tokio app.",
    ["terminal dashboard"],
    {
      activity: { state: "alive", label: "pushed 3 weeks ago" },
      stars: 4_100,
      starred: "Nov 19, 2025",
      network: [people.lena],
      visual: { kind: "icon", url: icons.console, plate: "none", size: 128, letters: "to" },
      unread: true,
    },
  ),
  result(
    "gyscos",
    "cursive",
    "A text UI library with views, layouts, and themes. Fewer chart widgets.",
    ["text UI library"],
    {
      activity: { state: "quiet", label: "pushed last month" },
      stars: 4_600,
      starred: "Jan 9, 2025",
      network: [],
      visual: { kind: "icon", url: icons.favicon, plate: "none", size: 16, letters: "gy" },
      unread: true,
    },
  ),
  result("fdehau", "tui-rs", "Where ratatui came from. Archived in 2023, so ratatui is the one to use.", [], {
    activity: { state: "archived" },
    stars: 11_100,
    starred: "Feb 21, 2025",
    network: [people.lena, people.kofi, people.mtsk],
    visual: { kind: "icon", url: icons.ghost, plate: "dark", size: 128, letters: "fd" },
  }),
];

export const ratatui: RepoDetail = {
  owner: "ratatui",
  name: "ratatui",
  language: "Rust",
  description: "A Rust crate for cooking up terminal user interfaces",
  summary:
    "Build terminal UIs in Rust from ready widgets: charts, gauges, sparklines, tables, and lists. It draws in immediate mode on crossterm, termion, or termwiz. The maintained fork of tui-rs.",
  stars: 16_400,
  starred: "Mar 14, 2025",
  activity: { state: "alive", label: "pushed 2 days ago" },
  release: "v0.29.0",
  license: "MIT",
  network: [people.lena, people.kofi, people.jprd, people.mtsk],
  alsoStarred: [
    { owner: "ClementTsang", name: "bottom", href: "?repo=ClementTsang/bottom", stars: 11_600 },
    { owner: "crossterm-rs", name: "crossterm", href: "?repo=crossterm-rs/crossterm", stars: 3_600 },
    { owner: "extrawurst", name: "gitui", href: "?repo=extrawurst/gitui", stars: 20_600 },
  ],
  githubUrl: "https://github.com/ratatui/ratatui",
  visual: { kind: "icon", url: icons.ratatui, plate: "light", size: 128, letters: "ra" },
};

const week = (index: number) => `2025-W${String(index + 1).padStart(2, "0")}`;

export const weeks: StarredWeek[] = Array.from({ length: 52 }, (_, index) => ({
  start: week(index),
  days: Array.from({ length: 7 }, (_, day) => ({
    date: `${week(index)}-${day + 1}`,
    stars: ((index * 7 + day) * 37) % 11 === 0 ? 9 : (index + day * 3) % 5,
  })),
}));

export const detailFor = (result: Result): RepoDetail =>
  result.name === ratatui.name
    ? ratatui
    : {
        owner: result.owner,
        name: result.name,
        language: "Rust",
        description: result.reason,
        summary: result.reason,
        stars: result.stars,
        starred: result.starred,
        activity: result.activity,
        network: result.network,
        alsoStarred: ratatui.alsoStarred.filter((related) => related.name !== result.name),
        githubUrl: `https://github.com/${result.owner}/${result.name}`,
        visual: result.visual,
      };
