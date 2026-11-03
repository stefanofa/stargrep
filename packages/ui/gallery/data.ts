import type { Match, Person, RepoDetail, Result } from "../src/index.ts";

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

const result = (
  owner: string,
  name: string,
  reason: string,
  words: string[],
  rest: Pick<Result, "activity" | "stars" | "starred" | "network">,
): Result => ({
  owner,
  name,
  href: `?repo=${owner}/${name}`,
  reason,
  matches: marks(reason, ...words),
  ...rest,
});

const ratatuiReason = "Widgets for charts, gauges, sparklines, and tables. The maintained fork of tui-rs.";

export const results: Result[] = [
  result("ratatui", "ratatui", ratatuiReason, ["charts, gauges, sparklines", "tui-rs"], {
    activity: { state: "alive", label: "pushed 2 days ago" },
    stars: 16_400,
    starred: "Mar 14, 2025",
    network: [people.lena, people.kofi, people.jprd, people.mtsk],
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
    },
  ),
  result("fdehau", "tui-rs", "Where ratatui came from. Archived in 2023, so ratatui is the one to use.", [], {
    activity: { state: "archived" },
    stars: 11_100,
    starred: "Feb 21, 2025",
    network: [people.lena, people.kofi, people.mtsk],
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
};

export const weeks = Array.from({ length: 52 }, (_, week) =>
  Array.from({ length: 7 }, (_, day) => (((week * 7 + day) * 37) % 11 === 0 ? 9 : (week + day * 3) % 5)),
);
