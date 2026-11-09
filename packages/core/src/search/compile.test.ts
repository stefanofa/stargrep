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
    expect(groups("parsers in rust")).toEqual(["boost any[parsers]"]);
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
    expect(groups("apps built with tauri")).toEqual(["filter built_with[tauri]"]);
    expect(groups("editor not built with electron")).toEqual(["boost any[editor]", "exclude built_with[electron]"]);
    // "with" and "using" name a feature as often as a dependency, so they only boost.
    expect(groups("apps using tauri")).toEqual(["boost any,built_with[tauri]"]);
    expect(groups("apps powered by electron")).toEqual(["filter built_with[electron]"]);
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
    ]);
  });

  test("applies kinds and statuses only where only narrows them, and joins closed alternatives into one group", () => {
    expect(groups("cli apps for macos or linux")).toEqual(["boost platform:macos|platform:linux"]);
    expect(groups("only cli apps for macos or linux", { kinds: ["cli"] })).toEqual([
      "filter kind:cli",
      "boost platform:macos|platform:linux",
    ]);
    expect(groups("only apps or libraries")).toEqual(["filter kind:app|kind:library"]);
    expect(groups("only cli apps")).toEqual(["filter kind:app"]);
    expect(groups("deprecated http clients")).toEqual(["boost any[http clients]"]);
    expect(groups("only deprecated http clients")).toEqual(["filter status:deprecated", "filter any[http clients]"]);
  });

  // The reviews of PR 95 found these. A negation reached a kind or platform word after other words, and "not" or "only"
  // anywhere made every kind and platform word a filter.
  test("narrows only the target of a negation, and reads no-code and non-blocking as words", () => {
    expect(groups("no-code app builder")).toEqual(["boost any[no code]", "boost any[builder]"]);
    expect(groups("no-code apps")).toEqual(["boost any[no code]"]);
    expect(groups("non-electron desktop apps")).toEqual(["boost any[non electron desktop]"]);
    expect(groups("without electron desktop apps")).toEqual(["exclude any,built_with[electron desktop]"]);
    expect(groups("no dependency cli tool")).toEqual(["exclude any,built_with[dependency]"]);
    expect(groups("no-std rust libraries", { languages: ["Rust"] })).toEqual(["filter lang:rust", "boost any[no std]"]);
    expect(groups("non blocking io libraries, no login notes app")).toEqual([
      "exclude any,built_with[blocking io]",
      "exclude any,built_with[login notes]",
    ]);
    expect(groups("alternative to notion ios app")).toEqual(["boost alternative_to[notion]", "boost platform:ios"]);
  });

  test("narrows only the target of only, and never promotes the rest of the query", () => {
    expect(groups("terminal emulator for linux only")).toEqual([
      "boost platform:terminal",
      "boost any[emulator]",
      "filter platform:linux",
    ]);
    expect(groups("configuration management tool, not puppet")).toEqual([
      "boost any[management]",
      "exclude any,built_with[puppet]",
    ]);
    expect(groups("tools for training models that do not need a gpu")).toEqual([
      "boost any[training]",
      "boost any[do]",
      "exclude any,built_with[need gpu]",
    ]);
    expect(groups("only cli tools for macos", { kinds: ["cli"] })).toEqual(["filter kind:cli", "boost platform:macos"]);
    expect(groups("only for macos or linux")).toEqual(["filter platform:macos|platform:linux"]);
    // A generic noun ends the words before it as a kind word does, so trufflehog keeps its place for this one.
    expect(groups("find secrets leaked in git repos")).toEqual(["boost any[find secrets leaked]", "boost any[git]"]);
  });

  test("keeps a relation's target out of the kinds the results may have", () => {
    expect(groups("only libraries for building apps", { kinds: ["library"] })).toEqual([
      "filter kind:library",
      "boost any[building]",
    ]);
    expect(groups("only libraries for building apps")).toEqual(["filter kind:library", "boost any[building]"]);
    expect(groups("only libraries, not apps", { kinds: ["library"] })).toEqual([
      "filter kind:library",
      "exclude kind:app",
    ]);
    expect(groups("only libraries, not app templates", { kinds: ["library"] })).toEqual([
      "filter kind:library",
      "exclude kind:app",
    ]);
  });

  test("carries a relation's role and negation into languages and platforms", () => {
    expect(groups("only apps built with node")).toEqual(["filter kind:app", "filter with:platform:node"]);
    expect(groups("apps not built with node")).toEqual(["exclude with:platform:node"]);
    expect(groups("terminal that runs on linux")).toEqual(["boost platform:terminal", "filter runs-on:platform:linux"]);
    expect(groups("apps that do not run on windows")).toEqual(["boost any[do]", "exclude runs-on:platform:windows"]);
    expect(groups("cli for node")).toEqual(["boost platform:node"]);
    expect(groups("only apps built with javascript", { languages: ["JavaScript"] })).toEqual([
      "filter written-in:lang:javascript|with:lang:javascript",
      "filter kind:app",
    ]);
    expect(groups("apps written in javascript", { languages: ["JavaScript"] })).toEqual([
      "filter written-in:lang:javascript",
    ]);
    expect(groups("apps not written in javascript", { languages: ["JavaScript"] })).toEqual([
      "exclude written-in:lang:javascript",
    ]);
    expect(groups("javascript apps not built with rust", { languages: ["JavaScript", "Rust"] })).toEqual([
      "filter lang:javascript",
      "exclude written-in:lang:rust|with:lang:rust",
    ]);
  });

  // The re-verify of PR 95 found these on real queries.
  test("reads a contraction with either apostrophe as a negation", () => {
    for (const query of [
      "apps that don't run on windows",
      "apps that don’t run on windows",
      "apps that dont run on windows",
      "apps that can't run on windows",
      "apps that won’t run on windows",
    ]) {
      expect([query, groups(query)]).toEqual([query, ["exclude runs-on:platform:windows"]]);
    }
    expect(groups("apps that aren't built with electron")).toEqual(["exclude built_with[electron]"]);
    expect(groups("a cli that isn't written in go", { languages: ["Go"] })).toEqual(["exclude written-in:lang:go"]);
    expect(groups("tools that doesn’t need a gpu")).toEqual(["exclude any,built_with[need gpu]"]);
    const query = "apps that don’t run on windows";
    const [spans] = compile(query).stated.map(({ spans }) => spans.map((span) => span && query.slice(...span)));
    expect(spans).toEqual(["windows"]);
  });

  test("never applies a closed value positively after a negation's target", () => {
    expect(groups("apps that do not support windows")).toEqual(["boost any[do]", "exclude any,built_with[support]"]);
    expect(groups("apps that do not support rust", { languages: ["Rust"] })).toEqual([
      "boost any[do]",
      "exclude any,built_with[support]",
    ]);
  });

  test("tests a language a built-with cue names where it is written in or built with", () => {
    expect(groups("cli tools built with rust", { languages: ["Rust"] })).toEqual([
      "filter written-in:lang:rust|with:lang:rust",
    ]);
    expect(groups("cli tools not built with go", { languages: ["Go"] })).toEqual([
      "exclude written-in:lang:go|with:lang:go",
    ]);
    expect(groups("apps built with node")).toEqual(["filter with:platform:node"]);
  });

  test("boosts what with and using name, and filters only on an explicit dependency cue", () => {
    expect(groups("llm apps with privacy")).toEqual(["boost any[llm]", "boost any,built_with[privacy]"]);
    expect(groups("editor with ai")).toEqual(["boost any[editor]", "boost any,built_with[ai]"]);
    expect(groups("login with github")).toEqual(["boost any[login]", "boost any,built_with[github]"]);
    expect(groups("only apps with ai")).toEqual(["filter kind:app", "boost any,built_with[ai]"]);
    expect(groups("apps with linux support")).toEqual(["boost platform:linux", "boost any[support]"]);
    expect(groups("web framework using typescript", { languages: ["TypeScript"] })).toEqual([
      "boost lang:typescript",
      "boost any[web framework]",
    ]);
    expect(groups("apps built using tauri")).toEqual(["filter built_with[tauri]"]);
    expect(groups("apps not using langchain")).toEqual(["exclude any,built_with[langchain]"]);
  });

  test("drops what it cannot be sure of", () => {
    expect(groups("parsers for a very long winded subject phrase")).toEqual(["boost any[parsers]"]);
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
