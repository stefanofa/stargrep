import { describe, expect, test } from "bun:test";
import { keywordTerms, searchText } from "../src/lib/keyword.ts";
import { matchesEvery, pageView } from "../src/lib/page-view.ts";
import { libraryRepos } from "./library-fixture.ts";

const entries = libraryRepos.map((repo) => ({ ...repo, text: searchText(repo) }));
const byId = new Map(entries.map((entry) => [entry.id as number, entry]));
const at = Date.parse("2026-11-06T00:00:00.000Z");
const sync = {
  login: "stefanofa",
  state: "done" as const,
  requestedAt: null,
  syncedAt: "2026-11-05T23:00:00.000Z",
  enrichment: { total: entries.length, read: entries.length, failed: 0 },
  starredTotal: entries.length,
  accountType: "user" as const,
  waiting: null,
};

const view = (query: string, results = [] as Parameters<typeof pageView>[0]["semantic"]["results"]) =>
  pageView({
    query,
    entries,
    matched: matchesEvery(entries, keywordTerms(query)),
    find: (id) => byId.get(id),
    sync,
    starred: sync.starredTotal,
    semantic: { results, pending: false, failed: false },
    sort: "best",
    at,
    timeLeft: undefined,
    whose: "stefanofa",
  });

describe("the first answer the server paints", () => {
  test("matches every term the way the live query does, case and wildcards aside", () => {
    const names = (query: string) => matchesEvery(entries, keywordTerms(query)).map((entry) => entry.name);
    expect(names("Terminal Dashboard")).toEqual(["bottom", "console"]);
    expect(names("terminal% dash_board")).toEqual(names("terminal dashboard"));
    expect(names("")).toEqual([]);
  });

  test("is the same view the page derives once its library is loaded", () => {
    const first = view("terminal dashboard");
    expect(first.status).toMatchObject({ icon: "found", label: "found 2!", detail: "in @stefanofa's 24 stars" });
    expect(view("terminal dashboard")).toEqual(first);
    if (first.body.kind !== "results") throw new Error("expected results");
    expect(first.body.groups.flatMap((group) => group.results.map((result) => result.name))).toEqual([
      "bottom",
      "console",
    ]);
  });
});
