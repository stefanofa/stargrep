import { expect, test } from "bun:test";
import { siteCard, siteCardPath } from "../scripts/og-image.ts";
import { themeColor } from "../scripts/theme.ts";
import { accountImage } from "../src/lib/preview.ts";
import type { LibraryRepo, SearchResult, SyncStatus } from "../src/lib/rpc.ts";
import { libraryRevision } from "../src/lib/sync-status.ts";
import { type CardSource, readAccountCard } from "../src/server/card/account.ts";
import { cardSize } from "../src/server/card/card.tsx";
import { palette } from "../src/server/card/palette.ts";
import { readTopicCard } from "../src/server/card/topic.ts";
import { libraryRepos } from "./library-fixture.ts";
import { syncStatus } from "./sync-status.fixture.ts";

const tokens: Record<keyof typeof palette, string> = {
  background: "background",
  card: "card",
  ink: "ink",
  inkSecondary: "ink-secondary",
  mutedForeground: "muted-foreground",
  muted: "muted",
  accent: "accent",
  accentSoft: "accent-soft",
  highlight: "highlight",
  highlightEdge: "highlight-edge",
  avatar: "avatar-2",
};

test("the cards paint the light theme's colors", () => {
  for (const [key, token] of Object.entries(tokens))
    expect([key, palette[key as keyof typeof palette]]).toEqual([key, themeColor(token).light.toLowerCase()]);
});

// The PNG header names the size at fixed offsets, so a preview's declared og:image size can be checked without a decoder.
const sizeOf = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

test("public/og.png is the site card the current layout draws, at the size the head declares", async () => {
  const drawn = await siteCard();
  expect(sizeOf(drawn)).toEqual(cardSize);
  const committed = await Bun.file(siteCardPath).bytes();
  expect(Buffer.compare(Buffer.from(committed), Buffer.from(drawn)), "run bun run --cwd apps/web og").toBe(0);
});

const login = "junodev";
const [unnamed] = libraryRepos.slice(6);
if (unnamed === undefined) throw new Error("short fixture");
// Rust leads, TypeScript and Zig tie, and one repo has no language, which counts toward the whole.
const library = [...libraryRepos.slice(0, 6), { ...unnamed, language: null }];

// What the API answers: one grouped count per language GitHub names, most first and ties by name, over every star.
const counted = (repos: ReadonlyArray<LibraryRepo>) => {
  const counts = new Map<string, number>();
  for (const { language } of repos) if (language !== null) counts.set(language, (counts.get(language) ?? 0) + 1);
  return {
    login,
    total: repos.length,
    languages: Array.from(counts, ([language, count]) => ({ language, count })).toSorted(
      (a, b) => b.count - a.count || a.language.localeCompare(b.language),
    ),
  };
};

const source = (sync: SyncStatus, cached: ReadonlyArray<SearchResult> = []) => {
  const asked = { stars: 0 };
  const card: CardSource = {
    status: async () => sync,
    library: async () => {
      asked.stars++;
      return library;
    },
    languages: async () => counted(library),
    cachedResults: async () => cached,
    avatar: async () => "data:image/png;base64,AA==",
  };
  return { card, asked };
};

test("a login's card counts its starred repos and the languages of the stars it imported, without reading them", async () => {
  const sync = syncStatus({ starredTotal: 1786 });
  const { card, asked } = source(sync);
  const read = await readAccountCard(card, login, "");
  expect(read.revision).toBe(libraryRevision(sync));
  expect(read.card).toEqual({
    login,
    avatar: "data:image/png;base64,AA==",
    stars: 1786,
    languages: [
      { name: "Rust", share: 4 / 7 },
      { name: "TypeScript", share: 1 / 7 },
      { name: "Zig", share: 1 / 7 },
    ],
    search: null,
  });
  expect(asked.stars).toBe(0);
});

test("a shared search shows the answer cache's best match and reads no library for it", async () => {
  const [first] = libraryRepos;
  if (first === undefined) throw new Error("empty fixture");
  const { card, asked } = source(syncStatus({}), [
    { ...first, description: "From the cache." } as unknown as SearchResult,
  ]);
  const read = await readAccountCard(card, login, "  fast   python ");
  expect(read.card.search).toEqual({
    query: "fast python",
    top: { owner: first.owner, name: first.name, about: "From the cache." },
  });
  expect(read.card.languages).toEqual([]);
  expect(asked.stars).toBe(0);
});

test("without a cached answer, a shared search shows its best keyword match from the library", async () => {
  const { card } = source(syncStatus({}));
  const read = await readAccountCard(card, login, "helix");
  expect(read.card.search?.top).toMatchObject({ owner: "helix-editor", name: "helix" });
  expect((await readAccountCard(card, login, "zzzz")).card.search).toEqual({ query: "zzzz", top: null });
});

test("a login Stargrep has not imported yet reads no library and claims no numbers", async () => {
  const { card, asked } = source(syncStatus({ state: "unknown" }));
  const read = await readAccountCard(card, login, "");
  expect(read.card).toMatchObject({ stars: null, languages: [], search: null });
  expect(read.revision).toBeNull();
  expect(asked.stars).toBe(0);
});

test("a stars page names its own card, with the library revision it read and its query", () => {
  expect(accountImage("octo", "2026-11-05/12/10/0", "rust tui")).toEqual({
    path: "/og/octo.png?v=2026-11-05%2F12%2F10%2F0&q=rust+tui",
    alt: "@octo's starred GitHub repos on stargrep",
  });
  expect(accountImage("octo", null, undefined).path).toBe("/og/octo.png");
});

test("a topic's card carries its curated logo on its plate, and a topic without one carries none", async () => {
  const card = (topic: string) =>
    readTopicCard(
      {
        topic: async () => ({
          topic,
          repos: 10,
          ranked: 5,
          icon: null,
          home: null,
          core: [],
          built: [],
          related: [],
          people: [],
        }),
        cachedTopicResults: async () => [],
      },
      topic,
      "",
    );
  const [nextjs, javascript, testing] = await Promise.all([card("nextjs"), card("javascript"), card("testing")]);
  expect(nextjs.logo?.src).toStartWith("data:image/svg+xml,");
  expect(decodeURIComponent(nextjs.logo?.src ?? "")).toContain('fill="#000000"');
  expect([nextjs.logo?.plate, javascript.logo?.plate, testing.logo]).toEqual(["light", "dark", null]);
});
