import { describe, expect, test } from "bun:test";
import { everything, formatAtom, SelectionKey } from "@stargrep/knowledge/atom";
import type { SubjectId } from "@stargrep/knowledge/ids";
import * as Schema from "effect/Schema";
import * as Compile from "./compile.ts";
import * as QueryPlan from "./query-plan.ts";

const selection = Schema.decodeSync(SelectionKey);

const compile = (query: string, planned: Partial<Compile.Planned> = {}) =>
  Compile.compileQuery({ query, planned: { ...QueryPlan.noFilters, ...planned }, explicit: everything });

const groups = (query: string, planned: Partial<Compile.Planned> = {}) =>
  compile(query, planned).stated.map(({ group }) =>
    group._tag === "Closed"
      ? `${group.mode} ${group.any.map((atom) => formatAtom(atom)).join("|")}`
      : `${group.mode} ${group.roles.join(",")}[${group.keys.join("|")}]`,
  );

describe("compileQuery", () => {
  test.each([
    [
      "rust TUI libraries for postgres",
      { languages: ["Rust"] },
      ["filter lang:rust", "boost any[tui]", "filter any[postgres]"],
    ],
    [
      "only rust TUI libraries for postgres",
      { languages: ["Rust"], kinds: ["library"] },
      ["filter lang:rust", "filter kind:library", "filter any[tui]", "filter any[postgres]"],
    ],
    ["self-hosted alternative to slack", {}, ["boost any[self hosted]", "boost alternative_to[slack]"]],
    ["open source Slack alternative", {}, ["boost alternative_to[slack]"]],
    ["libraries for node", {}, ["boost platform:node"]],
    ["customizable shell prompt", {}, ["boost any[customizable shell prompt]"]],
    [
      "postgres or mysql clients for rust",
      { languages: ["Rust"] },
      ["filter lang:rust", "boost any[postgres|mysql clients]"],
    ],
    ["sqlite or duckdb wrappers in go", { languages: ["Go"] }, ["filter lang:go", "boost any[sqlite|duckdb wrappers]"]],
    ["bindings for postgres or sqlite", {}, ["boost any[bindings]", "filter any[postgres|sqlite]"]],
    ["markdown editor without electron", {}, ["boost any[markdown editor]", "exclude any,built_with[electron]"]],
    ["graph libraries for rust", { languages: ["Rust"] }, ["filter lang:rust", "boost any[graph]"]],
    ["библиотеки на питоне", { languages: ["Python"] }, ["filter lang:python"]],
    ["ratatui/ratatui", {}, []],
  ] as const)("%s", (query, planned, expected) => {
    expect(groups(query, planned)).toEqual([...expected]);
  });

  test("takes languages and licenses only from the planner, so other language words stay ordinary", () => {
    expect(groups("convert pdf to markdown")).toEqual(["boost any[convert pdf markdown]"]);
    expect(groups("tools in rust")).toEqual(["boost any[tools]"]);
    expect(groups("mit licensed chart libraries", { licenses: ["MIT"] })).toEqual([
      "filter license:MIT",
      "boost any[chart]",
    ]);
    expect(groups("node.js orm", { languages: ["Node.js", "JavaScript"] })).toEqual([
      "filter lang:javascript",
      "boost platform:node",
      "boost any[orm]",
    ]);
  });

  test("reads built-with cues, negations, and comparisons with closed values", () => {
    expect(groups("apps built with tauri")).toEqual(["filter any,built_with[tauri]"]);
    // "not" also makes every stated group strict.
    expect(groups("editor not built with electron")).toEqual([
      "filter any[editor]",
      "exclude any,built_with[electron]",
    ]);
    expect(groups("deno alternative to node")).toEqual(["boost platform:deno", "boost alt:platform:node"]);
    expect(groups("apps, not libraries", { kinds: ["app"] })).toEqual(["filter kind:app", "exclude kind:library"]);
    expect(groups("password manager without electron, for linux")).toEqual([
      "boost any[password manager]",
      "exclude any,built_with[electron]",
      "boost platform:linux",
    ]);
  });

  // The recall eval with subjects accepted at the floor rule lost these repos when a cut clause filtered and when the
  // cue reached past a closed word.
  test("boosts a relation clause a closed word cuts short, and starts a bare clause after a closed word", () => {
    expect(groups("ChatGPT style web UI for local models")).toEqual([
      "boost any[chatgpt style web ui]",
      "boost any[local]",
    ]);
    expect(groups("go library for building terminal user interfaces", { languages: ["Go"] })).toEqual([
      "filter lang:go",
      "boost any[building]",
      "boost platform:terminal",
      "boost any[user interfaces]",
    ]);
    expect(groups("framework for building LLM apps and agents")).toEqual([
      "boost any[building llm]",
      "boost any[agents]",
    ]);
    expect(groups("without macos or linux apps")).toEqual(["exclude platform:macos|platform:linux"]);
    expect(groups("for macos or vim without linux deno")).toEqual([
      "boost platform:macos",
      "boost any[vim]",
      "exclude platform:linux",
      "boost platform:deno",
    ]);
  });

  test("applies kinds and statuses only in strict mode, and joins closed alternatives into one group", () => {
    expect(groups("cli apps for macos or linux")).toEqual(["boost platform:macos|platform:linux"]);
    expect(groups("only cli apps for macos or linux", { kinds: ["cli"] })).toEqual([
      "filter kind:cli|kind:app",
      "filter platform:macos|platform:linux",
    ]);
    expect(groups("deprecated http clients")).toEqual(["boost any[http clients]"]);
  });

  test("drops what it cannot be sure of", () => {
    expect(groups("tools for a very long winded subject phrase")).toEqual(["boost any[tools]"]);
    expect(groups("clients for foo or bar or baz or qux or quux")).toEqual(["boost any[clients]"]);
    expect(groups("stars for postgres starred last year with more than 200 stars")).toEqual(["filter any[postgres]"]);
    const many = groups("a1 for b1 with c1 using d1 for e1 with f1 using g1 for h1 with i1 using j1");
    expect(many).toHaveLength(8);
  });

  test("keeps the caller's selection whatever the words say, and skips the compiler for a name", () => {
    const explicit = selection("lang:rust -kind:list");
    const compiled = Compile.compileQuery({ query: "ratatui", planned: QueryPlan.noFilters, explicit });
    expect(compiled).toEqual({ explicit, stated: [] });
  });

  test("records where each atom and key sits in the query", () => {
    const query = "rust TUI libraries for postgres or sqlite";
    const spans = compile(query, { languages: ["Rust"] }).stated.map(({ spans }) =>
      spans.map((span) => (span === null ? null : query.slice(...span))),
    );
    expect(spans).toEqual([["rust"], ["TUI"], ["postgres", "sqlite"]]);
  });
});

describe("applied", () => {
  test("lists explicit atoms, closed groups, and the subject groups SQL resolved, with labels", () => {
    const query = "rust TUI libraries for postgres or sqlite";
    const compiled = Compile.compileQuery({
      query,
      planned: { ...QueryPlan.noFilters, languages: ["Rust"] },
      explicit: selection("-kind:list subject:9"),
    });
    const atoms = Compile.applied(compiled, {
      stated: [[], null, [812 as SubjectId, 9031 as SubjectId]],
      labels: { "9": "Neovim", "812": "PostgreSQL", "9031": "SQLite" },
      unavailable: [],
    });
    expect(atoms).toEqual([
      { atom: "kind:list", label: "list", mode: "exclude", from: "filter", span: null },
      { atom: "subject:9", label: "Neovim", mode: "filter", from: "filter", span: null },
      { atom: "lang:rust", label: "Rust", mode: "filter", from: "query", span: [0, 4] },
      { atom: "subject:812", label: "PostgreSQL", mode: "filter", from: "query", span: [23, 31] },
      { atom: "subject:9031", label: "SQLite", mode: "filter", from: "query", span: [35, 41] },
    ]);
  });
});
