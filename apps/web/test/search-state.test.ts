import { describe, expect, test } from "bun:test";
import {
  type Answer,
  emptyCopy,
  headingsOf,
  rephrasings,
  type Stage,
  searchView,
  stageOf,
} from "../src/lib/search-state.ts";

const importing = stageOf({ importing: true, imported: 1204, starred: 1776, enrichment: null });
const reading = stageOf({
  importing: false,
  imported: 1776,
  starred: 1776,
  enrichment: { total: 1776, read: 412, failed: 0 },
});
const ready = stageOf({
  importing: false,
  imported: 1776,
  starred: 1776,
  enrichment: { total: 1776, read: 1776, failed: 0 },
});

const view = (stage: Stage, answer: Answer, extra: { syncFailed?: boolean; synced?: string } = {}) =>
  searchView({
    stage,
    answer,
    synced: extra.synced,
    syncFailed: extra.syncFailed ?? false,
    timeLeft: "about 6 minutes left",
  });

const browsing: Answer = { kind: "browsing" };

describe("the stage", () => {
  test("importing wins while the sync runs, and an unknown star count leaves the total open", () => {
    expect(importing).toEqual({ name: "importing", done: 1204, total: 1776, read: null });
    expect(stageOf({ importing: true, imported: 40, starred: null, enrichment: null })).toMatchObject({ total: null });
  });

  test("reading lasts until every star is read or failed", () => {
    expect(reading).toEqual({ name: "reading", read: 412, settled: 412, total: 1776 });
    const settled = stageOf({
      importing: false,
      imported: 1776,
      starred: 1776,
      enrichment: { total: 1776, read: 1770, failed: 6 },
    });
    expect(settled).toEqual({ name: "ready", total: 1776, failed: 6 });
  });

  test("a server without read progress is ready once import ends", () => {
    expect(stageOf({ importing: false, imported: 95, starred: 95, enrichment: null })).toEqual({
      name: "ready",
      total: 95,
      failed: 0,
    });
  });
});

describe("the strip, rail, mark and body for each state", () => {
  test("browsing a synced library", () => {
    expect(view(ready, browsing, { synced: "synced 2 min ago" })).toEqual({
      status: { icon: "synced", label: "1,776 stars", detail: "synced 2 min ago" },
      rail: undefined,
      pose: "idle",
      body: "library",
    });
  });

  test("importing shows real counts on the strip and the rail", () => {
    const state = view(importing, browsing);
    expect(state.status).toEqual({
      icon: "busy",
      label: "importing your stars",
      detail: "1,204 of 1,776 · about 6 minutes left",
    });
    expect(state.rail).toBeCloseTo(1204 / 1776);
    expect(state.pose).toBe("happy");
  });

  test("importing with no known total counts up and draws no rail", () => {
    const state = view(stageOf({ importing: true, imported: 40, starred: null, enrichment: null }), browsing);
    expect(state.status.detail).toBe("40 imported so far");
    expect(state.rail).toBeUndefined();
  });

  test("reading moves the same rail to the read count", () => {
    const state = view(reading, browsing);
    expect(state.status).toEqual({
      icon: "busy",
      label: "reading your stars",
      detail: "412 of 1,776 understood · names and descriptions already searchable",
    });
    expect(state.rail).toBeCloseTo(412 / 1776);
    expect(state.pose).toBe("thinking");
  });

  test("searching before any answer", () => {
    const state = view(reading, { kind: "searching" });
    expect(state.status).toEqual({ icon: "busy", label: "searching", detail: "1,364 stars not read yet" });
    expect(state.pose).toBe("thinking");
    expect(state.body).toBe("results");
  });

  test("results while reading say they are partial", () => {
    const state = view(reading, { kind: "found", count: 3 });
    expect(state.status).toEqual({ icon: "busy", label: "found 3 so far", detail: "1,364 stars not read yet" });
    expect(state.body).toBe("results");
  });

  test("results once everything is read just count", () => {
    const state = view(ready, { kind: "found", count: 6 });
    expect(state.status).toEqual({ icon: "found", label: "found 6", detail: "of 1,776" });
    expect(state.rail).toBeUndefined();
    expect(state.pose).toBe("idle");
  });

  test("nothing yet while reading is a different empty state from nothing at all", () => {
    const partial = view(reading, { kind: "none" });
    expect(partial.status).toEqual({ icon: "busy", label: "nothing yet", detail: "1,364 stars not read yet" });
    expect(partial.body).toBe("empty-reading");
    expect(partial.pose).toBe("unsure");

    const final = view(ready, { kind: "none" });
    expect(final.status).toEqual({ icon: "done", label: "nothing found", detail: "all 1,776 stars read" });
    expect(final.body).toBe("empty");
    expect(final.pose).toBe("sad");
  });

  test("an empty answer never claims every star was read when some failed", () => {
    const stage = stageOf({
      importing: false,
      imported: 1776,
      starred: 1776,
      enrichment: { total: 1776, read: 1770, failed: 6 },
    });
    expect(view(stage, { kind: "none" }).status.detail).toBe("1,770 of 1,776 stars read");
  });

  test("a failed sync offers a retry and scares the mark", () => {
    const state = view(ready, browsing, { syncFailed: true });
    expect(state.status).toEqual({
      icon: "failed",
      label: "sync didn't finish",
      detail: "1,776 stars so far",
      retry: true,
    });
    expect(state.pose).toBe("scared");
  });

  test("a search that failed with no keyword hits says so", () => {
    const state = view(ready, { kind: "failed" });
    expect(state.body).toBe("failed");
    expect(state.pose).toBe("scared");
  });
});

describe("group headings", () => {
  test("show while stars are still being read", () => {
    expect(headingsOf(reading, 3, 2)).toEqual({
      words: { label: "matching words", detail: "3 from all 1,776" },
      meaning: { label: "matching meaning", detail: "2 from the 412 read so far" },
    });
  });

  test("count what has arrived while importing", () => {
    expect(headingsOf(importing, 3, 0)?.words.detail).toBe("3 from the 1,204 imported so far");
    expect(headingsOf(importing, 3, 0)?.meaning.detail).toBe("0 so far");
  });

  test("go away once everything is read", () => {
    expect(headingsOf(ready, 3, 2)).toBeUndefined();
  });
});

describe("empty state copy", () => {
  test("while reading, the answer could still be in the unread part", () => {
    expect(emptyCopy(reading, "about 6 minutes left", false)).toEqual({
      heading: "not in the 412 i've read yet",
      body: "it might be in the 1,364 stars i'm still reading.",
      meta: "i'll search again when reading finishes · about 6 minutes left",
    });
  });

  test("before anything is read, it says so instead of counting zero", () => {
    const fresh = stageOf({
      importing: false,
      imported: 6,
      starred: 6,
      enrichment: { total: 6, read: 0, failed: 0 },
    });
    expect(emptyCopy(fresh, undefined, false)).toEqual({
      heading: "i haven't read your stars yet",
      body: "names and descriptions already match. the rest can match once i've read them.",
      meta: "i'll search again when reading finishes",
    });
  });

  test("after everything is read, it offers other words only when it has some", () => {
    expect(emptyCopy(ready, "", true).body).toEndWith("try one of these:");
    expect(emptyCopy(ready, "", false).body).not.toContain("try one of these");
    expect(emptyCopy(ready, "", true).heading).toBe("nothing in all 1,776 stars");
    const someFailed = stageOf({
      importing: false,
      imported: 1776,
      starred: 1776,
      enrichment: { total: 1776, read: 1770, failed: 6 },
    });
    expect(emptyCopy(someFailed, "", false).body).toStartWith("i've read every one i could");
  });
});

describe("rephrasings", () => {
  test("offers shorter phrasings from the query's own words", () => {
    expect(rephrasings(["record", "terminal", "sessions", "gifs"])).toEqual([
      "record terminal",
      "terminal sessions",
      "sessions gifs",
    ]);
    expect(rephrasings(["terminal", "recorder"])).toEqual(["terminal", "recorder"]);
  });

  test("offers nothing for a one word query", () => {
    expect(rephrasings(["asciinema"])).toEqual([]);
  });
});
