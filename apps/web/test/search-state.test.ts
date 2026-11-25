import { describe, expect, test } from "bun:test";
import type { Result } from "@stargrep/ui";
import type { Audience, Owner } from "../src/lib/audience.ts";
import {
  type PageInputs,
  pageView,
  type Search,
  type SearchView,
  type Stage,
  searchView,
  stageOf,
} from "../src/lib/search-state.ts";
import type { Trouble } from "../src/lib/trouble.ts";
import { syncStatus } from "./sync-status.fixture.ts";

const landed = { stars: 1200, pushedAt: "2026-11-01T00:00:00.000Z" };
const pending = { stars: null, pushedAt: null };

const entries = (count: number, arriving = 0) =>
  Array.from({ length: count }, (_, index) => (index < arriving ? pending : landed));

const sync = syncStatus;

const importing = stageOf({
  sync: sync({ state: "queued", syncedAt: null, enrichment: { total: 1204, read: 0, failed: 0, queued: 0 } }),
  entries: entries(1204),
  starred: 1776,
});
const reading = stageOf({
  sync: sync({ enrichment: { total: 1776, read: 412, failed: 0, queued: 0 } }),
  entries: entries(1776),
  starred: 1776,
});
const ready = stageOf({ sync: sync({}), entries: entries(1776), starred: 1776 });
const someFailed = stageOf({
  sync: sync({ enrichment: { total: 1776, read: 1770, failed: 6, queued: 0 } }),
  entries: entries(1776),
  starred: 1776,
});
const capped = stageOf({
  sync: sync({ enrichment: { total: 1776, read: 1464, failed: 0, queued: 312 } }),
  entries: entries(1776),
  starred: 1776,
});

const results = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ owner: prefix, name: `${prefix}-${index}` }) as unknown as Result);

const search = (extra: Partial<Search> = {}): Search => ({
  terms: [],
  words: [],
  meaning: [],
  semantic: "none",
  hasMatches: () => true,
  ...extra,
});

const view = (stage: Stage, extra: Partial<Search> = {}) =>
  searchView({ stage, search: search(extra), timeLeft: "about 6 minutes left", whose: { own: true } });

const query = { terms: ["record", "terminal", "sessions", "gifs"] };

describe("the stage", () => {
  test("a first sync imports, and an unknown star count leaves the total open", () => {
    expect(importing).toEqual({ name: "importing", done: 1204, total: 1776, read: 0, phase: { kind: "running" } });
    const unknown = stageOf({ sync: sync({ state: "queued", syncedAt: null }), entries: entries(40), starred: null });
    expect(unknown).toMatchObject({ name: "importing", total: null });
  });

  test("a login nobody asked to import yet is ready to import, with the importing layout", () => {
    const fresh = stageOf({ sync: sync({ state: "unknown", syncedAt: null }), entries: [], starred: null });
    expect(fresh).toMatchObject({ name: "importing", phase: { kind: "not-asked" }, done: 0 });
  });

  test("a first sync waiting for github budget is in line, with its place and start time", () => {
    const waiting = { ahead: 3, startsAt: "2026-11-05T10:24:00.000Z" };
    const inLine = stageOf({ sync: sync({ state: "waiting", syncedAt: null, waiting }), entries: [], starred: 412 });
    expect(inLine).toMatchObject({ name: "importing", phase: { kind: "in-line", ...waiting } });
  });

  test("reading lasts until every star is read or failed", () => {
    expect(reading).toEqual({ name: "reading", read: 412, settled: 412, total: 1776 });
    expect(someFailed).toEqual({ name: "ready", total: 1776, failed: 6, queued: 0, lastSync: "done" });
  });

  test("stars the daily summary cap queued for later settle the library instead of keeping it reading", () => {
    expect(capped).toEqual({ name: "ready", total: 1776, failed: 0, queued: 312, lastSync: "done" });
    const stillReading = stageOf({
      sync: sync({ enrichment: { total: 1776, read: 1464, failed: 0, queued: 300 } }),
      entries: entries(1776),
      starred: 1776,
    });
    expect(stillReading).toEqual({ name: "reading", read: 1464, settled: 1464, total: 1776 });
  });

  test("before the sync status arrives, the library reads as ready", () => {
    expect(stageOf({ sync: undefined, entries: entries(95), starred: 95 })).toEqual({
      name: "ready",
      total: 95,
      failed: 0,
      queued: 0,
      lastSync: "done",
    });
  });

  test("a sync on a library that synced before checks for new stars instead of importing", () => {
    const checking = stageOf({ sync: sync({ state: "queued" }), entries: entries(1776), starred: 1776 });
    expect(checking).toEqual({ name: "refreshing", total: 1776, arriving: 0 });
  });

  test("a few new stars being read stay a refresh, a large backlog is reading", () => {
    const few = stageOf({
      sync: sync({ enrichment: { total: 1778, read: 1776, failed: 0, queued: 0 } }),
      entries: entries(1778, 2),
      starred: 1778,
    });
    expect(few).toEqual({ name: "refreshing", total: 1778, arriving: 2 });
    const backlog = stageOf({
      sync: sync({ enrichment: { total: 1776, read: 412, failed: 0, queued: 0 } }),
      entries: entries(1776, 1364),
      starred: 1776,
    });
    expect(backlog.name).toBe("reading");
  });

  test("a failed sync remembers whether the library had synced before", () => {
    const first = stageOf({ sync: sync({ state: "failed", syncedAt: null }), entries: entries(40), starred: 1776 });
    expect(first).toMatchObject({ name: "ready", lastSync: "failed-first" });
    const again = stageOf({ sync: sync({ state: "failed" }), entries: entries(1776), starred: 1776 });
    expect(again).toMatchObject({ name: "ready", lastSync: "failed-refresh" });
  });
});

describe("browsing", () => {
  test("says nothing about the pipeline, and the rail alone shows an import or a read", () => {
    const refreshing: Stage = { name: "refreshing", total: 1778, arriving: 2 };
    for (const stage of [ready, capped, importing, reading, refreshing]) expect(view(stage).status).toBeUndefined();
    expect(view(ready).body).toEqual({ kind: "library", arriving: undefined });
    expect(view(capped).progress).toBeUndefined();
    expect(view(refreshing).progress).toBeUndefined();
    expect(view(importing).progress).toEqual({
      value: 1204,
      max: 1776,
      label: "importing your stars",
      text: "1,204 of 1,776 imported",
    });
    expect(view(reading).progress).toEqual({
      value: 412,
      max: 1776,
      label: "reading your stars",
      text: "412 of 1,776 read",
    });
    expect([view(importing).pose, view(reading).pose, view(refreshing).pose]).toEqual(["happy", "thinking", "idle"]);
  });

  test("importing with no known total draws no rail", () => {
    const state = view(
      stageOf({ sync: sync({ state: "queued", syncedAt: null }), entries: entries(40), starred: null }),
    );
    expect(state.progress).toBeUndefined();
  });

  test("a sync that failed says so and offers a retry, and a failed first sync scares the mark", () => {
    const first = view({ name: "ready", total: 40, failed: 0, queued: 0, lastSync: "failed-first" });
    expect(first.status).toEqual({ label: "sync didn't finish", retry: "sync" });
    expect(first.pose).toBe("scared");
    expect(view({ name: "ready", total: 1776, failed: 0, queued: 0, lastSync: "failed-refresh" }).status).toEqual({
      label: "couldn't check for new stars",
      phoneLabel: "couldn't check",
      retry: "sync",
    });
  });
});

describe("searching", () => {
  test("before any answer, placeholders hold the meaning group", () => {
    const state = view(reading, { terms: ["tui"], semantic: "pending" });
    expect(state.status).toEqual({ label: "searching…" });
    expect(state.pose).toBe("thinking");
    expect(state.body).toEqual({
      kind: "results",
      groups: [
        {
          key: "meaning",
          heading: { label: "matching meaning", detail: "0 from the 412 read so far" },
          results: [],
          pending: 4,
        },
      ],
    });
  });

  test("results while reading are grouped and say they are partial", () => {
    const state = view(reading, { terms: ["tui"], words: results("w", 2), meaning: results("m", 1) });
    expect(state.status).toEqual({ label: "found 3 so far" });
    expect(state.body.kind === "results" && state.body.groups.map((group) => group.heading)).toEqual([
      { label: "matching words", detail: "2 from all 1,776" },
      { label: "matching meaning", detail: "1 from the 412 read so far" },
    ]);
  });

  test("results while importing count what has arrived", () => {
    const state = view(importing, { terms: ["tui"], words: results("w", 3) });
    expect(state.body.kind === "results" && state.body.groups[0]?.heading?.detail).toBe(
      "3 from the 1,204 imported so far",
    );
  });

  test("results once everything is read are one list with a plain count", () => {
    const state = view(ready, {
      terms: ["tui"],
      words: results("w", 2),
      meaning: results("m", 4),
      semantic: "answered",
    });
    expect(state.status).toEqual({ label: "found 6!" });
    expect(state.progress).toBeUndefined();
    expect(state.pose).toBe("idle");
    expect(state.body).toEqual({
      kind: "results",
      groups: [{ key: "all", results: [...results("w", 2), ...results("m", 4)], pending: 0 }],
    });
  });

  test("nothing yet while reading could still be in the unread part", () => {
    const state = view(reading, query);
    expect(state.status).toEqual({ label: "nothing yet" });
    expect(state.pose).toBe("unsure");
    expect(state.body).toEqual({
      kind: "empty-reading",
      copy: {
        heading: "not in the 412 i've read yet",
        body: "it might be in the 1,364 stars i'm still reading.",
        meta: "i'll search again when reading finishes · about 6 minutes left",
      },
      ring: 412 / 1776,
    });
  });

  test("before anything is read, the empty state says so instead of counting zero", () => {
    const fresh = stageOf({
      sync: sync({ enrichment: { total: 6, read: 0, failed: 0, queued: 0 } }),
      entries: entries(6),
      starred: 6,
    });
    const state = searchView({
      stage: fresh,
      search: search(query),
      timeLeft: undefined,
      whose: { own: true },
    });
    expect(state.body.kind === "empty-reading" && state.body.copy).toEqual({
      heading: "i haven't read your stars yet",
      body: "names and descriptions already match. the rest can match once i've read them.",
      meta: "i'll search again when reading finishes",
    });
  });

  test("nothing after everything is read is a real no, with rephrasings from the query's words", () => {
    const state = view(ready, query);
    expect(state.status).toEqual({ label: "nothing found" });
    expect(state.pose).toBe("sad");
    expect(state.body).toEqual({
      kind: "empty",
      copy: {
        heading: "nothing in all 1,776 stars",
        body: "i've read all of them, and none matches that. maybe you starred it under different words. try one of these:",
      },
      phrases: ["record terminal", "terminal sessions", "sessions gifs"],
    });
  });

  test("a two word query rephrases to each word, a one word query offers nothing", () => {
    const two = view(ready, { terms: ["terminal", "recorder"] }).body;
    expect(two.kind === "empty" && two.phrases).toEqual(["terminal", "recorder"]);
    const one = view(ready, { terms: ["asciinema"] }).body;
    expect(one.kind === "empty" && one.phrases).toEqual([]);
    expect(one.kind === "empty" && one.copy.body).not.toContain("try one of these");
  });

  test("suggests only words that find something, so nonsense gets no chips", () => {
    const nonsense = view(ready, { terms: ["qzxvbnm", "wplkj"], hasMatches: () => false }).body;
    expect(nonsense.kind === "empty" && nonsense.phrases).toEqual([]);
    expect(nonsense.kind === "empty" && nonsense.copy.body).not.toContain("try one of these");
    const some = view(ready, { ...query, hasMatches: (words) => words.includes("terminal") }).body;
    expect(some.kind === "empty" && some.phrases).toEqual(["record terminal", "terminal sessions", "terminal"]);
    const short = view(ready, { terms: ["terminal", "as", "gifs"] }).body;
    expect(short.kind === "empty" && short.phrases).toEqual(["terminal as", "as gifs", "terminal"]);
  });

  test("an empty answer never claims every star was read when some failed", () => {
    const state = view(someFailed, query);
    expect(state.body.kind === "empty" && state.body.copy.body).toStartWith("i've read every one i could");
  });

  test("a search that failed with no keyword hits says so and offers to search again", () => {
    const state = view(ready, { terms: ["tui"], semantic: "failed" });
    expect(state.status).toEqual({ label: "search didn't answer", phoneLabel: "search failed", retry: "search" });
    expect(state.body).toEqual({
      kind: "failed",
      copy: { heading: "stargrep couldn't search that", body: "the search didn't answer. try again in a moment." },
    });
    expect(state.pose).toBe("scared");
  });

  test("an earlier query's results stay on screen, and the status says the new query is still searching", () => {
    const state = view(ready, { terms: ["qzxvbnm"], meaning: results("m", 20), semantic: "pending" });
    expect(state.status).toEqual({ label: "searching…" });
    expect(state.pose).toBe("thinking");
    expect(state.body).toEqual({ kind: "results", groups: [{ key: "all", results: results("m", 20), pending: 2 }] });
  });

  test("keyword matches for the new query count while its meaning search is pending", () => {
    const state = view(ready, { terms: ["tui"], words: results("w", 2), semantic: "pending" });
    expect(state.status).toEqual({ label: "found 2!" });
  });

  test("a meaning search that failed beside keyword matches keeps them, says so, and offers to search again", () => {
    const state = view(reading, { terms: ["tui"], words: results("w", 2), semantic: "failed" });
    expect(state.status).toEqual({
      label: "found 2 · meaning search didn't answer",
      phoneLabel: "found 2 · meaning failed",
      retry: "search",
    });
    expect(state.pose).toBe("scared");
    expect(state.body.kind === "results" && state.body.groups.flatMap((group) => group.results)).toEqual(
      results("w", 2),
    );
  });

  test("a network that searched too often is asked for a breather, not told the search broke", () => {
    const alone = view(ready, { terms: ["tui"], semantic: "limited" });
    expect(alone.status).toEqual({ label: "taking a breather", retry: "search" });
    expect(alone.body).toEqual({
      kind: "failed",
      copy: { heading: "lots of searches from your network", body: "give it a minute, then try again." },
    });
    expect(alone.pose).toBe("unsure");
    const beside = view(ready, { terms: ["tui"], words: results("w", 1), semantic: "limited" });
    expect(beside.status).toEqual({
      label: "found 1 · meaning search is taking a breather",
      phoneLabel: "found 1 · taking a breather",
      retry: "search",
    });
  });
});

const importingFor = (extra: Partial<Extract<Stage, { name: "importing" }>> = {}): Stage => ({
  name: "importing",
  done: 14,
  total: 28,
  read: 0,
  phase: { kind: "running" },
  ...extra,
});

const juno = { login: "juno", name: null, avatarUrl: null, starredCount: 6 };
const anyone = (owner: Partial<Owner> = {}): Audience => ({
  by: "anyone",
  owner: { login: "octo", demo: false, ...owner },
});
const signedIn: Audience = { by: "signed-in", viewer: juno, owner: { login: "octo", demo: false } };
const ownPage: Audience = { by: "owner", viewer: juno, owner: { login: "juno", demo: false } };

const page = (extra: Partial<PageInputs> = {}) =>
  pageView({
    audience: anyone(),
    query: "",
    stage: ready,
    live: view(ready),
    first: undefined,
    library: { ready: true, whole: true },
    trouble: undefined,
    surprised: false,
    ...extra,
  });

describe("what the page shows", () => {
  const answered = view(ready, { terms: ["tui"], words: results("w", 2) });
  const serverAnswer: SearchView = view(reading, { terms: ["terminal"], meaning: results("m", 1) });

  test("trouble wins over any answer, with its own pose and try again, and leaves the strip to its tile", () => {
    const troubled = page({ query: "tui", live: answered, trouble: "load-failed" });
    expect(troubled.status).toBeUndefined();
    expect(troubled.pose).toBe("scared");
    expect(troubled.body).toEqual({
      kind: "trouble",
      heading: "stargrep couldn't load @octo's stars",
      detail: "the library didn't arrive. try again in a moment.",
      retry: "library",
      offer: undefined,
    });
  });

  test("until the library loads, the page holds placeholders in the final layout", () => {
    const loading = page({ query: "tui", library: { ready: false, whole: false }, stage: importingFor() });
    expect(loading.status).toBeUndefined();
    expect(loading.body).toEqual({ kind: "loading", searching: true, arriving: { total: 28 } });
    expect(loading.progress).toBeUndefined();
    expect(loading.painted).toBe(false);
  });

  test("the server's answer holds until the library has every page, then the live view takes over", () => {
    const first = { query: "Terminal  dashboard", view: serverAnswer };
    const held = page({ query: "terminal dashboard", live: answered, first, library: { ready: true, whole: false } });
    expect(held.painted).toBe(true);
    expect(held.status).toEqual(serverAnswer.status);
    expect(held.body).toEqual(serverAnswer.body);
    expect(held.progress).toEqual(serverAnswer.progress);
    expect(page({ query: "terminal dashboard", first, library: { ready: false, whole: false } }).painted).toBe(true);
    const whole = page({ query: "terminal dashboard", live: answered, first });
    expect(whole.painted).toBe(false);
    expect(whole.status).toEqual(answered.status);
  });

  test("a query other than the server's never shows the server's answer", () => {
    const first = { query: "terminal dashboard", view: serverAnswer };
    const other = page({ query: "tui", live: answered, first, library: { ready: true, whole: false } });
    expect(other.painted).toBe(false);
    expect(other.status).toEqual(answered.status);
    expect(page({ query: "tui", first, library: { ready: false, whole: false } }).body.kind).toBe("loading");
  });

  test("results by meaning surprise an idle mark for a moment, but never a troubled one", () => {
    expect(page({ live: answered, surprised: true }).pose).toBe("surprised");
    expect(page({ live: view(reading), surprised: true }).pose).toBe("thinking");
    expect(page({ live: answered, surprised: true, trouble: "busy" }).pose).toBe("unsure");
  });
});

const demo = anyone({ login: "stefanofa", demo: true });
const hero = (stage: Stage, extra: Partial<PageInputs> = {}) => page({ stage, audience: demo, ...extra }).hero;
const person = (stage: Stage, extra: Partial<PageInputs> = {}) => page({ stage, ...extra }).person;
const stefanofa = { login: "stefanofa" };

describe("the hero above a visitor's look at the demo account", () => {
  test("shows on the demo account to visitors only", () => {
    expect(hero(ready, { audience: anyone() })).toBeUndefined();
    expect(hero(ready, { audience: signedIn })).toBeUndefined();
    expect(hero(ready, { audience: { ...signedIn, owner: { login: "stefanofa", demo: true } } })).toBeUndefined();
    expect(hero(ready, { audience: ownPage })).toBeUndefined();
  });

  test("introduces the demo account", () => {
    expect(hero(ready)).toEqual({
      subtitle: ["live results from ", stefanofa, ", our demo account. try any username."],
      butter: { kind: "join" },
    });
  });

  test("asks whether the visitor is the owner while the demo's stars import, with the import's progress", () => {
    expect(hero(importingFor())).toEqual({
      subtitle: [
        stefanofa,
        " is new here. their stars are on the way from GitHub, and search covers the ones that landed.",
      ],
      butter: { kind: "claim", progress: 0.5 },
    });
  });

  test("says a login nobody asked for yet is ready to import", () => {
    expect(hero(importingFor({ done: 0, total: null, phase: { kind: "not-asked" } }))).toEqual({
      subtitle: [
        stefanofa,
        " is new here. their stars are ready to import from GitHub, and search covers them as they land.",
      ],
      butter: { kind: "claim", progress: 0 },
    });
  });
  test("points to another username when the page is in trouble", () => {
    expect(hero(importingFor({ phase: { kind: "not-asked" } }), { trouble: "missing" })).toEqual({
      subtitle: ["try any username."],
      butter: { kind: "join" },
    });
  });
});

describe("the person above the stars", () => {
  test("shows on every page but the landing, your own included", () => {
    expect(person(ready)).toEqual({ login: "octo", known: true });
    expect(person(importingFor(), { audience: signedIn })).toEqual({ login: "octo", known: true });
    expect(person(ready, { audience: { ...signedIn, owner: { login: "stefanofa", demo: true } } })?.login).toBe(
      "stefanofa",
    );
    expect(person(ready, { audience: ownPage })).toEqual({ login: "juno", known: true });
    expect(person(ready, { audience: demo })).toBeUndefined();
  });

  test("a login GitHub doesn't know keeps its handle but no profile", () => {
    expect(person(importingFor({ phase: { kind: "not-asked" } }), { trouble: "missing" })).toEqual({
      login: "octo",
      known: false,
    });
    expect(person(ready, { trouble: "busy" })).toEqual({ login: "octo", known: true });
  });
});

const troubles: ReadonlyArray<Trouble> = ["missing", "busy", "limited", "unavailable", "load-limited", "load-failed"];

const troubled = (trouble: Trouble, extra: Partial<PageInputs> = {}) => page({ trouble, ...extra });

const troubleBody = (trouble: Trouble, extra: Partial<PageInputs> = {}) => {
  const { body } = troubled(trouble, extra);
  if (body.kind !== "trouble") throw new Error(`expected trouble, got ${body.kind}`);
  return body;
};

describe("a page in trouble", () => {
  test("one network limit reads the same wherever it hits", () => {
    expect(troubleBody("limited").heading).toBe(troubleBody("load-limited").heading);
  });

  test("offers the right try again, and none for a login GitHub doesn't know", () => {
    expect(troubles.map((trouble) => troubleBody(trouble).retry)).toEqual([
      undefined,
      "sync",
      "sync",
      "sync",
      "library",
      "library",
    ]);
  });

  test("sends a login GitHub doesn't know to the people list, and nothing else there", () => {
    expect(troubles.map((trouble) => troubleBody(trouble).offer)).toEqual([
      "people",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
