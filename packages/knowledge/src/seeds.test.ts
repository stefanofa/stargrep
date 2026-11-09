import { describe, expect, test } from "bun:test";
import { empty, extend, type KnowledgeState } from "./decisions.ts";
import { Revision, SubjectId } from "./ids.ts";
import { type LabelKey, labelKey } from "./label-key.ts";
import { type Holder, noise, planSeeds, type SeedEntry, spells } from "./seeds.ts";

const s = (id: number) => SubjectId.make(id);
const key = (text: string) => labelKey(text) as LabelKey;
const entry = (
  label: string,
  aliases: ReadonlyArray<string> = [],
  seedKey?: string,
  synonyms: ReadonlyArray<string> = [],
): SeedEntry => ({
  ...(seedKey === undefined ? {} : { key: seedKey }),
  label,
  definition: `about ${label}`,
  aliases,
  synonyms,
  status: "accepted",
  reason: "seed",
});
const holder = (id: number, label: string, status: Holder["status"] = "candidate"): Holder => ({
  id: s(id),
  canonicalId: s(id),
  label,
  definition: null,
  status,
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
const decisionsOf = (result: ReturnType<typeof plan>) => result.decisions.map(({ decision }) => decision);

describe("spells", () => {
  test("keeps separators, dots, plurals, a js suffix, versions, and expansions, and nothing else", () => {
    const yes: ReadonlyArray<readonly [string, string]> = [
      ["react-js", "react"],
      ["reactjs", "react"],
      ["next.js", "nextjs"],
      ["llms", "llm"],
      ["websockets", "websocket"],
      ["python3", "python"],
      ["laravel-10", "laravel"],
      ["model-context-protocol", "mcp"],
      ["text-based-user-interface", "Text-based user interface"],
    ];
    const no: ReadonlyArray<readonly [string, string]> = [
      ["headless", "headless-browser"],
      ["stealth", "stealth-game"],
      ["repl", "replit"],
      ["3d-printing", "3d"],
      ["normalization", "css-reset"],
      ["paper", "bukkit"],
      ["d2", "d"],
      ["api-server", "api-client"],
    ];
    for (const [alias, name] of [...yes, ...no]) {
      expect([alias, name, spells(key(alias), key(name))]).toEqual([alias, name, yes.some(([a]) => a === alias)]);
    }
  });
});

describe("planSeeds", () => {
  test("creates an entry no subject holds, with the free names that spell it", () => {
    expect(decisionsOf(plan([entry("TUI", ["tui", "terminal-user-interface", "cli"], "tui")]))).toEqual([
      {
        _tag: "Create",
        label: "TUI",
        definition: "about TUI",
        aliases: ["terminal-user-interface"],
        status: "accepted",
      },
    ]);
  });

  test("adopts the holder of the entry's own key and leaves every other holder to the judge", () => {
    const react = holder(1, "react");
    const reactjs = holder(2, "reactjs");
    const result = plan(
      [entry("React", ["reactjs", "react-js", "jsx"], "react")],
      [
        ["react", react],
        ["reactjs", reactjs],
      ],
    );
    expect(decisionsOf(result)).toEqual([
      { _tag: "Rename", subject: s(1), label: "React", definition: "about React" },
      { _tag: "Alias", subject: s(1), label: "react-js", add: true },
      { _tag: "Status", subject: s(1), status: "accepted" },
    ]);
    expect(result.proposals.map(({ decision }) => decision)).toEqual([{ _tag: "Merge", from: s(2), into: s(1) }]);
  });

  test("adopts the holder of the label's key when the entry's own key is free, and takes the free key", () => {
    const result = plan(
      [entry("Text-based user interface", [], "tui")],
      [["text based user interface", holder(7, "text based user interface")]],
    );
    expect(decisionsOf(result)).toEqual([
      {
        _tag: "Rename",
        subject: s(7),
        label: "Text-based user interface",
        definition: "about Text-based user interface",
      },
      { _tag: "Alias", subject: s(7), label: "tui", add: true },
      { _tag: "Status", subject: s(7), status: "accepted" },
    ]);
  });

  test("keeps the adopted subject's label, and leaves the label's spellings, when another subject holds the label's key", () => {
    const result = plan(
      [entry("Tailwind CSS", ["tailwind-css", "tailwindcss"], "tailwind")],
      [
        ["tailwind", holder(1950, "Tailwind")],
        ["tailwind css", holder(1229, "Tailwind CSS")],
      ],
    );
    expect(decisionsOf(result)).toEqual([
      { _tag: "Rename", subject: s(1950), definition: "about Tailwind CSS" },
      { _tag: "Status", subject: s(1950), status: "accepted" },
    ]);
    expect(result.proposals.map(({ decision }) => decision)).toEqual([{ _tag: "Merge", from: s(1229), into: s(1950) }]);
  });

  test("relabels only to the same name written another way, and never to a bare slug", () => {
    const result = plan(
      [entry("turn-based-strategy", [], "turn-based-strategy"), entry("Large Language Model", ["llms"], "llm")],
      [
        ["turn based strategy", holder(8, "turn-based strategy")],
        ["llm", holder(9, "LLM")],
      ],
    );
    expect(decisionsOf(result).filter((decision) => decision._tag === "Rename")).toEqual([
      { _tag: "Rename", subject: s(8), definition: "about turn-based-strategy" },
      { _tag: "Rename", subject: s(9), definition: "about Large Language Model" },
    ]);
  });

  test("keeps a reviewed synonym that does not spell the entry", () => {
    expect(decisionsOf(plan([entry("PostgreSQL", ["psql"], "postgresql", ["postgres"])]))).toEqual([
      {
        _tag: "Create",
        label: "PostgreSQL",
        definition: "about PostgreSQL",
        aliases: ["postgres"],
        status: "accepted",
      },
    ]);
  });

  test("skips a reserved key, an excluded one, a duplicate, and a rejected holder, and keeps a curator's status", () => {
    const rejected = holder(3, "open source", "rejected");
    const curated = holder(4, "Ratatui", "accepted");
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
    expect(decisionsOf(result).map((decision) => decision._tag)).toEqual(["Rename"]);
  });

  test("never proposes a rejected subject, and leaves out its name", () => {
    const result = plan(
      [entry("Tauri", ["tauris"], "tauri")],
      [
        ["tauri", holder(5, "Tauri")],
        ["tauris", holder(6, "tauris", "rejected")],
      ],
    );
    expect(decisionsOf(result)).toEqual([
      { _tag: "Rename", subject: s(5), definition: "about Tauri" },
      { _tag: "Status", subject: s(5), status: "accepted" },
    ]);
    expect(result.proposals).toEqual([]);
  });

  test("a noise seed rejects what holds its keys, takes its synonyms, and renames nothing", () => {
    const openSource = holder(30, "open-source", "accepted");
    const result = plan(noise, [["open source", openSource]]);
    expect(decisionsOf(result)).toEqual([
      expect.objectContaining({ _tag: "Create", label: "Hacktoberfest", status: "rejected" }),
      { _tag: "Alias", subject: s(30), label: "opensource", add: true },
      { _tag: "Alias", subject: s(30), label: "oss", add: true },
      { _tag: "Status", subject: s(30), status: "rejected" },
      expect.objectContaining({ _tag: "Create", label: "awesome", status: "rejected" }),
    ]);
  });

  test("proposes no merge the fold refuses", () => {
    const kept = extend(empty, [
      { revision: Revision.make(1), decision: { _tag: "KeepApart", a: s(1), b: s(2), add: true }, created: null },
    ]);
    if (kept._tag !== "Applied") throw new Error("keep-apart applies");
    const result = plan(
      [entry("React", ["reactjs"], "react")],
      [
        ["react", holder(1, "React")],
        ["reactjs", holder(2, "reactjs")],
      ],
      [],
      kept.state,
    );
    expect(decisionsOf(result).map((decision) => decision._tag)).toEqual(["Rename", "Status"]);
    expect(result.proposals).toEqual([]);
  });

  test("plans nothing for an entry the vocabulary already holds", () => {
    const created = plan([entry("TUI", [], "tui")]);
    const [decision] = decisionsOf(created);
    if (decision === undefined) throw new Error("a create");
    const applied = extend(empty, [{ revision: Revision.make(1), decision, created: s(40) }]);
    if (applied._tag !== "Applied") throw new Error("the create applies");
    const again = planSeeds({
      entries: [entry("TUI", [], "tui")],
      state: applied.state,
      holders: new Map([[key("tui"), s(40)]]),
      subjects: new Map([[s(40), { ...holder(40, "TUI", "accepted"), definition: "about TUI" }]]),
      excluded: new Set(),
    });
    expect(again.decisions).toEqual([]);
  });
});
