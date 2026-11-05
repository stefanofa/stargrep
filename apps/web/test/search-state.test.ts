import { describe, expect, test } from "bun:test";
import type { Result } from "@stargrep/ui";
import type { SyncStatus } from "../src/lib/rpc.ts";
import { type Search, type Stage, searchView, stageOf } from "../src/lib/search-state.ts";

const landed = { stars: 1200, pushedAt: "2026-11-01T00:00:00.000Z" };
const pending = { stars: null, pushedAt: null };

const entries = (count: number, arriving = 0) =>
  Array.from({ length: count }, (_, index) => (index < arriving ? pending : landed));

const sync = (extra: Partial<SyncStatus>): SyncStatus => ({
  login: "junodev",
  state: "done",
  requestedAt: "2026-11-05T10:00:00.000Z",
  syncedAt: "2026-11-05T10:00:00.000Z",
  enrichment: { total: 1776, read: 1776, failed: 0 },
  ...extra,
});

const importing = stageOf({
  sync: sync({ state: "queued", syncedAt: null, enrichment: { total: 1204, read: 0, failed: 0 } }),
  entries: entries(1204),
  starred: 1776,
});
const reading = stageOf({
  sync: sync({ enrichment: { total: 1776, read: 412, failed: 0 } }),
  entries: entries(1776),
  starred: 1776,
});
const ready = stageOf({ sync: sync({}), entries: entries(1776), starred: 1776 });
const someFailed = stageOf({
  sync: sync({ enrichment: { total: 1776, read: 1770, failed: 6 } }),
  entries: entries(1776),
  starred: 1776,
});

const results = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ owner: prefix, name: `${prefix}-${index}` }) as unknown as Result);

const search = (extra: Partial<Search> = {}): Search => ({
  terms: [],
  words: [],
  meaning: [],
  pending: false,
  failed: false,
  ...extra,
});

const view = (stage: Stage, extra: Partial<Search> = {}, synced?: string) =>
  searchView({ stage, search: search(extra), synced, timeLeft: "about 6 minutes left" });

const query = { terms: ["record", "terminal", "sessions", "gifs"] };

describe("the stage", () => {
  test("a first sync imports, and an unknown star count leaves the total open", () => {
    expect(importing).toEqual({ name: "importing", done: 1204, total: 1776, read: 0 });
    const unknown = stageOf({ sync: sync({ state: "queued", syncedAt: null }), entries: entries(40), starred: null });
    expect(unknown).toMatchObject({ name: "importing", total: null });
  });

  test("reading lasts until every star is read or failed", () => {
    expect(reading).toEqual({ name: "reading", read: 412, settled: 412, total: 1776 });
    expect(someFailed).toEqual({ name: "ready", total: 1776, failed: 6, lastSync: "done" });
  });

  test("before the sync status arrives, the library reads as ready", () => {
    expect(stageOf({ sync: undefined, entries: entries(95), starred: 95 })).toEqual({
      name: "ready",
      total: 95,
      failed: 0,
      lastSync: "done",
    });
  });

  test("a sync on a library that synced before checks for new stars instead of importing", () => {
    const checking = stageOf({ sync: sync({ state: "queued" }), entries: entries(1776), starred: 1776 });
    expect(checking).toEqual({ name: "refreshing", total: 1776, arriving: 0 });
  });

  test("a few new stars being read stay a refresh, a large backlog is reading", () => {
    const few = stageOf({
      sync: sync({ enrichment: { total: 1778, read: 1776, failed: 0 } }),
      entries: entries(1778, 2),
      starred: 1778,
    });
    expect(few).toEqual({ name: "refreshing", total: 1778, arriving: 2 });
    const backlog = stageOf({
      sync: sync({ enrichment: { total: 1776, read: 412, failed: 0 } }),
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
  test("a synced library counts its stars", () => {
    expect(view(ready, {}, "synced 2 min ago")).toEqual({
      status: { icon: "synced", label: "1,776 stars", detail: "synced 2 min ago" },
      progress: undefined,
      pose: "idle",
      body: { kind: "library" },
    });
  });

  test("importing shows real counts on the strip and the progress bar", () => {
    const state = view(importing);
    expect(state.status).toEqual({
      icon: "busy",
      label: "importing your stars",
      detail: "1,204 of 1,776 · about 6 minutes left",
    });
    expect(state.progress).toEqual({
      value: 1204,
      max: 1776,
      label: "importing your stars",
      text: "1,204 of 1,776 imported",
    });
    expect(state.pose).toBe("happy");
  });

  test("importing with no known total counts up and draws no progress bar", () => {
    const state = view(
      stageOf({ sync: sync({ state: "queued", syncedAt: null }), entries: entries(40), starred: null }),
    );
    expect(state.status.detail).toBe("40 imported so far");
    expect(state.progress).toBeUndefined();
  });

  test("reading moves the same bar to the read count", () => {
    const state = view(reading);
    expect(state.status).toEqual({
      icon: "busy",
      label: "reading your stars",
      detail: "412 of 1,776 understood · names and descriptions already searchable",
    });
    expect(state.progress).toEqual({ value: 412, max: 1776, label: "reading your stars", text: "412 of 1,776 read" });
    expect(state.pose).toBe("thinking");
  });

  test("checking for new stars is quiet, then counts the new stars while they are read", () => {
    const checking = view({ name: "refreshing", total: 1776, arriving: 0 });
    expect(checking.status).toEqual({ icon: "busy", label: "checking for new stars" });
    expect(checking.progress).toBeUndefined();
    expect(checking.body).toEqual({ kind: "library" });
    expect(checking.pose).toBe("idle");
    expect(view({ name: "refreshing", total: 1778, arriving: 2 }).status).toEqual({
      icon: "busy",
      label: "2 new stars",
      detail: "reading…",
    });
  });

  test("a failed first sync offers a retry and scares the mark", () => {
    const state = view({ name: "ready", total: 40, failed: 0, lastSync: "failed-first" });
    expect(state.status).toEqual({
      icon: "failed",
      label: "sync didn't finish",
      detail: "40 stars so far",
      retry: true,
    });
    expect(state.pose).toBe("scared");
  });

  test("a failed check on a synced library says it couldn't check", () => {
    const state = view({ name: "ready", total: 1776, failed: 0, lastSync: "failed-refresh" }, {}, "synced 2 min ago");
    expect(state.status).toEqual({
      icon: "failed",
      label: "couldn't check",
      detail: "for new stars",
      continues: true,
      retry: true,
    });
  });
});

describe("searching", () => {
  test("before any answer, placeholders hold the meaning group", () => {
    const state = view(reading, { terms: ["tui"], pending: true });
    expect(state.status).toEqual({ icon: "busy", label: "searching", detail: "1,364 stars not read yet" });
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
    expect(state.status).toEqual({ icon: "busy", label: "found 3 so far", detail: "1,364 stars not read yet" });
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
    const state = view(ready, { terms: ["tui"], words: results("w", 2), meaning: results("m", 4), pending: true });
    expect(state.status).toEqual({ icon: "found", label: "found 6", detail: "of 1,776", continues: true });
    expect(state.progress).toBeUndefined();
    expect(state.pose).toBe("idle");
    expect(state.body).toEqual({
      kind: "results",
      groups: [{ key: "all", results: [...results("w", 2), ...results("m", 4)], pending: 2 }],
    });
  });

  test("nothing yet while reading could still be in the unread part", () => {
    const state = view(reading, query);
    expect(state.status).toEqual({ icon: "busy", label: "nothing yet", detail: "1,364 stars not read yet" });
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
      sync: sync({ enrichment: { total: 6, read: 0, failed: 0 } }),
      entries: entries(6),
      starred: 6,
    });
    const state = searchView({ stage: fresh, search: search(query), synced: undefined, timeLeft: undefined });
    expect(state.body.kind === "empty-reading" && state.body.copy).toEqual({
      heading: "i haven't read your stars yet",
      body: "names and descriptions already match. the rest can match once i've read them.",
      meta: "i'll search again when reading finishes",
    });
  });

  test("nothing after everything is read is a real no, with rephrasings from the query's words", () => {
    const state = view(ready, query);
    expect(state.status).toEqual({ icon: "done", label: "nothing found", detail: "all 1,776 stars read" });
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

  test("an empty answer never claims every star was read when some failed", () => {
    const state = view(someFailed, query);
    expect(state.status.detail).toBe("1,770 of 1,776 stars read");
    expect(state.body.kind === "empty" && state.body.copy.body).toStartWith("i've read every one i could");
  });

  test("a search that failed with no keyword hits says so", () => {
    const state = view(ready, { terms: ["tui"], failed: true });
    expect(state.body).toEqual({
      kind: "failed",
      copy: { heading: "stargrep couldn't search that", body: "the search didn't answer. try again in a moment." },
    });
    expect(state.pose).toBe("scared");
  });
});
