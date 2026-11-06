import { describe, expect, test } from "bun:test";
import { heroCopy } from "../src/components/landing-hero.tsx";
import type { Stage } from "../src/lib/search-state.ts";

const ready: Stage = { name: "ready", total: 27, failed: 0, lastSync: "done" };
const importing = (extra: Partial<Extract<Stage, { name: "importing" }>> = {}): Stage => ({
  name: "importing",
  done: 14,
  total: 28,
  read: 0,
  line: null,
  starting: false,
  ...extra,
});
const copy = (stage: Stage, troubled = false, owner = "octo") =>
  heroCopy({ stage, troubled, owner, demoLogin: "stefanofa" });

describe("the hero above a visitor's search", () => {
  test("introduces the demo account, case aside", () => {
    expect(copy(ready, false, "StefanoFA")).toEqual({
      subtitle: "live results from @StefanoFA, our demo account. try any username.",
      butter: { kind: "join" },
    });
  });

  test("names anyone else's stars", () => {
    expect(copy(ready).subtitle).toBe("@octo's stars, searched in plain words. try any username.");
  });

  test("asks whether the visitor is the owner while their stars import, with the import's progress", () => {
    expect(copy(importing())).toEqual({
      subtitle: "@octo is new here. their stars are on the way from github, and search covers the ones that landed.",
      butter: { kind: "claim", progress: 0.5 },
    });
    expect(copy(importing({ total: null, starting: true })).butter).toEqual({ kind: "claim", progress: 0 });
  });

  test("says an import waits in line, and leaves its start time to the status line", () => {
    const waiting = importing({ done: 0, line: { ahead: 3, startsAt: "2026-11-06T12:00:00.000Z" } });
    expect(copy(waiting).subtitle).toBe(
      "@octo is new here and waits in line for github. search covers their stars as they land.",
    );
  });

  test("points to another username when the page is in trouble", () => {
    expect(copy(importing({ starting: true }), true)).toEqual({
      subtitle: "try any username.",
      butter: { kind: "join" },
    });
  });
});
