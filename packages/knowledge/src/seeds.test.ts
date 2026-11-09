import { describe, expect, test } from "bun:test";
import { empty, extend, type KnowledgeState } from "./decisions.ts";
import { Revision, SubjectId } from "./ids.ts";
import { type LabelKey, labelKey } from "./label-key.ts";
import { type Holder, noise, planSeeds, type SeedEntry } from "./seeds.ts";

const s = (id: number) => SubjectId.make(id);
const key = (text: string) => labelKey(text) as LabelKey;
const entry = (label: string, aliases: ReadonlyArray<string> = [], seedKey?: string): SeedEntry => ({
  ...(seedKey === undefined ? {} : { key: seedKey }),
  label,
  definition: `about ${label}`,
  aliases,
  status: "accepted",
  reason: "seed",
});
const holder = (id: number, label: string, repoCount: number, status: Holder["status"] = "candidate"): Holder => ({
  id: s(id),
  canonicalId: s(id),
  label,
  definition: null,
  status,
  repoCount,
});
const plan = (
  entries: ReadonlyArray<SeedEntry>,
  held: ReadonlyArray<readonly [string, Holder]> = [],
  excluded: ReadonlyArray<string> = [],
  state: KnowledgeState = empty,
) =>
  planSeeds({
    entries,
    state,
    holders: new Map(held.map(([text, info]) => [key(text), info.id])),
    subjects: new Map(held.map(([, info]) => [info.id, info])),
    excluded: new Set(excluded.map(key)),
  });

describe("planSeeds", () => {
  test("creates an entry no subject holds, with its free spellings as aliases", () => {
    expect(plan([entry("TUI", ["tui", "terminal-user-interface"], "tui")]).decisions).toEqual([
      {
        decision: {
          _tag: "Create",
          label: "TUI",
          definition: "about TUI",
          aliases: ["terminal-user-interface"],
          status: "accepted",
        },
        reason: "seed",
      },
    ]);
  });

  test("adopts the subject that holds the entry's own key and merges the other holders into it", () => {
    const react = holder(1, "react", 300);
    const reactjs = holder(2, "reactjs", 400);
    const result = plan(
      [entry("React", ["react", "reactjs", "react-js"], "react")],
      [
        ["react", react],
        ["reactjs", reactjs],
      ],
    );
    expect(result.decisions.map(({ decision }) => decision)).toEqual([
      { _tag: "Merge", from: s(2), into: s(1) },
      { _tag: "Rename", subject: s(1), label: "React", definition: "about React" },
      { _tag: "Alias", subject: s(1), label: "react-js", add: true },
      { _tag: "Status", subject: s(1), status: "accepted" },
    ]);
  });

  test("skips a reserved key, an excluded one, a duplicate, and a rejected holder, and keeps a curator's status", () => {
    const rejected = holder(3, "open source", 90, "rejected");
    const curated = holder(4, "Ratatui", 50, "accepted");
    const result = plan(
      [
        entry("Rust"),
        entry("Open Source", [], "open-source"),
        entry("Ratatui"),
        entry("ratatui"),
        entry("Hacktoberfest"),
      ],
      [
        ["open source", rejected],
        ["ratatui", curated],
      ],
      ["hacktoberfest"],
    );
    expect(result.skipped).toEqual([
      { label: "Rust", reason: "reserved" },
      { label: "Open Source", reason: "rejected" },
      { label: "ratatui", reason: "duplicate" },
      { label: "Hacktoberfest", reason: "excluded" },
    ]);
    expect(result.decisions.map(({ decision }) => decision._tag)).toEqual(["Rename"]);
  });

  test("an accepting seed leaves out a spelling a rejected subject holds, instead of merging that subject", () => {
    const result = plan(
      [entry("Tauri", ["tauri", "tauri app"], "tauri")],
      [
        ["tauri", holder(5, "Tauri", 40)],
        ["tauri app", holder(6, "tauri app", 3, "rejected")],
      ],
    );
    expect(result.decisions.map(({ decision }) => decision)).toEqual([
      { _tag: "Rename", subject: s(5), definition: "about Tauri" },
      { _tag: "Status", subject: s(5), status: "accepted" },
    ]);
    expect(result.droppedKeys).toBe(1);
  });

  test("a noise seed rejects what holds its keys and renames nothing", () => {
    const openSource = holder(30, "open-source", 93, "accepted");
    const result = plan(noise, [["open source", openSource]]);
    expect(result.decisions.map(({ decision }) => decision)).toEqual([
      expect.objectContaining({ _tag: "Create", label: "Hacktoberfest", status: "rejected" }),
      { _tag: "Alias", subject: s(30), label: "opensource", add: true },
      { _tag: "Alias", subject: s(30), label: "oss", add: true },
      { _tag: "Status", subject: s(30), status: "rejected" },
      expect.objectContaining({ _tag: "Create", label: "awesome", status: "rejected" }),
    ]);
  });

  test("leaves out a merge the fold refuses, and the keys of its holder", () => {
    const kept = extend(empty, [
      { revision: Revision.make(1), decision: { _tag: "KeepApart", a: s(1), b: s(2), add: true }, created: null },
    ]);
    if (kept._tag !== "Applied") throw new Error("keep-apart applies");
    const result = plan(
      [entry("React", ["react", "reactjs"], "react")],
      [
        ["react", holder(1, "React", 300)],
        ["reactjs", holder(2, "reactjs", 10)],
      ],
      [],
      kept.state,
    );
    expect(result.decisions.map(({ decision }) => decision._tag)).toEqual(["Rename", "Status"]);
    expect(result.droppedKeys).toBe(1);
  });
});
