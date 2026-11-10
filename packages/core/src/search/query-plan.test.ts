import { describe, expect, test } from "bun:test";
import { everything, formatAtom } from "@stargrep/knowledge/atom";
import * as Schema from "effect/Schema";
import * as Compile from "./compile.ts";
import * as PlannerPrompt from "./planner-prompt.ts";
import * as QueryPlan from "./query-plan.ts";

const decode = Schema.decodeUnknownSync(QueryPlan.PlannerOutput);
const encode = Schema.encodeSync(QueryPlan.PlannerOutput);

const answer = {
  semanticText: "A TypeScript library that maps database tables to typed objects.",
  filters: {
    languages: [{ language: "TypeScript", said: "typescript" }],
    kinds: ["library"],
    licenses: [],
    archived: null,
    starredAfter: "2025-01-01",
    starredBefore: "2026-01-01",
    metrics: [{ metric: "active_contributors_growth_90d", op: "gt", value: 0.2 }],
  },
  ranking: { _tag: "metric", metric: "stars", direction: "highest" },
};

const kept = (query: string, language: string, said: string) =>
  QueryPlan.fromPlannerOutput(
    query,
    decode({ ...answer, filters: { ...answer.filters, languages: [{ language, said }] } }),
  ).filters.languages;

describe("QueryPlan", () => {
  test("decodes a planner answer with filters, dates, and a metric ranking, and full-texts the typed words", () => {
    const plan = QueryPlan.fromPlannerOutput("typescript orm starred last year", decode(answer));
    expect(plan.textQuery).toBe("typescript orm starred last year");
    expect(plan.exactName).toBeNull();
    expect(plan.filters.languages).toEqual(["TypeScript"]);
    expect(plan.filters.starredAfter?.toString()).toContain("2025-01-01");
    expect(plan.filters.metrics[0]?.metric).toBe("active_contributors_growth_90d");
    expect(plan.ranking).toEqual({ _tag: "metric", metric: "stars", direction: "highest" });
  });

  test("rejects a plan that names a metric outside the registry, wherever it names it", () => {
    const sqlMetric = "stars; drop table stars";
    expect(() =>
      decode({ ...answer, filters: { ...answer.filters, metrics: [{ metric: sqlMetric, op: "gt", value: 1 }] } }),
    ).toThrow();
    expect(() =>
      decode({ ...answer, filters: { ...answer.filters, metrics: [{ metric: "stars", op: "> 1; --", value: 1 }] } }),
    ).toThrow();
    expect(() =>
      decode({ ...answer, ranking: { _tag: "metric", metric: "pg_sleep(10)", direction: "highest" } }),
    ).toThrow();
    expect(() => decode({ ...answer, filters: { ...answer.filters, starredAfter: "last year" } })).toThrow();
  });

  test("keeps a kind filter only when the query restricts the kind", () => {
    const output = decode(answer);
    expect(QueryPlan.fromPlannerOutput("open source apps like Wispr Flow", output).filters.kinds).toEqual([]);
    expect(QueryPlan.fromPlannerOutput("rust library for terminal dashboards", output).filters.kinds).toEqual([]);
    expect(QueryPlan.fromPlannerOutput("only libraries for orms", output).filters.kinds).toEqual(["library"]);
    expect(QueryPlan.fromPlannerOutput("orm libraries, not apps", output).filters.kinds).toEqual(["library"]);
  });

  test("keeps a language whose quoted words are its name, an alias, or a translation in another script", () => {
    for (const [query, language, said] of [
      ["GDScript game engine", "GDScript", "GDScript"],
      ["SCSS component library", "SCSS", "scss"],
      ["CUDA math library", "CUDA", "CUDA"],
      ["node cli", "JavaScript", "node"],
      ["ts orm", "TypeScript", "ts"],
      ["библиотеки на питоне для веба", "Python", "питоне"],
      ["библиотека на расте для json", "Rust", "расте"],
      ["фреймворк на джаваскрипте", "JavaScript", "джаваскрипте"],
      ["用Python写的网络框架", "Python", "Python"],
      ["Pythonで書かれたウェブフレームワーク", "Python", "Python"],
      ["C++で書かれたJSONライブラリ", "C++", "C++"],
      ["パイソンのウェブフレームワーク", "Python", "パイソン"],
      ["用于网页的蟒蛇语言库", "Python", "蟒蛇语言"],
    ] as const) {
      expect([query, kept(query, language, said)]).toEqual([query, [language]]);
    }
  });

  test("ends a word at a digit, so python3 keeps Python and a quoted d in d3 charts would keep D", () => {
    expect(kept("python3 scripts", "Python", "python")).toEqual(["Python"]);
    expect(kept("d3 charts", "D", "d")).toEqual(["D"]);
  });

  test("drops a language quoted from a framework, a runtime, or part of a longer name", () => {
    for (const [query, language, said] of [
      ["spring boot starter", "Java", "spring boot"],
      ["nextjs auth", "JavaScript", "js"],
      ["rails admin gem", "Ruby", "rails"],
      ["django rest", "Python", "django"],
      ["flutter widgets", "Dart", "flutter"],
      ["build mobile apps with react", "JavaScript", "react"],
    ] as const) {
      expect([query, kept(query, language, said)]).toEqual([query, []]);
    }
  });

  test("drops a language whose quoted words are missing from the query", () => {
    const languages = (query: string, stated: ReadonlyArray<{ language: string; said: string }>) =>
      QueryPlan.fromPlannerOutput(query, decode({ ...answer, filters: { ...answer.filters, languages: stated } }))
        .filters.languages;
    expect(languages("react state library", [{ language: "JavaScript", said: "javascript" }])).toEqual([]);
    expect(
      languages("node.js orm", [
        { language: "Node.js", said: "node.js" },
        { language: "TypeScript", said: "typescript" },
      ]),
    ).toEqual(["Node.js"]);
    expect(languages("rust cli", [{ language: "Rust", said: "" }])).toEqual([]);
    expect(languages("tsconfig loader", [{ language: "TypeScript", said: "ts" }])).toEqual([]);
  });

  test("classifies names, short keyword lists, and sentences", () => {
    const kinds = (queries: ReadonlyArray<string>) => queries.map((query) => [query, QueryPlan.queryKind(query)]);
    const names = ["ratatui", "ratatui/ratatui", "next.js", "k9s", "vim", "emacs", "jupyter"];
    const keywords = ["react query", "tanstack table", "common crawl", "notebook viewer"];
    const sentences = [
      "rust library for terminal dashboards",
      "typescript orm starred last year",
      "apps like notion",
      "most popular editors",
      "react 19 forms",
      "postgres gui clients maintained",
      "self-hosted git service",
    ];
    expect(kinds(names)).toEqual(names.map((query) => [query, "name"]));
    expect(kinds(keywords)).toEqual(keywords.map((query) => [query, "keywords"]));
    expect(kinds(sentences)).toEqual(sentences.map((query) => [query, "sentence"]));
  });

  test("sends a short query that names a filter to the planner", () => {
    for (const query of [
      "only TypeScript CLIs",
      "only MIT libraries",
      "selbst gehostete Fotoverwaltung",
      "rust cli",
      "mit license",
      "python",
      "repos 2024",
    ]) {
      expect([query, QueryPlan.queryKind(query)]).toEqual([query, "sentence"]);
    }
  });

  test("searches a query as typed, pinning only a name", () => {
    expect(QueryPlan.asTyped("ratatui/ratatui", "name").exactName).toBe("ratatui/ratatui");
    expect(QueryPlan.asTyped("rust tui", "keywords")).toEqual({
      semanticText: "rust tui",
      textQuery: "rust tui",
      exactName: null,
      filters: QueryPlan.noFilters,
      ranking: { _tag: "relevance" },
    });
  });

  test("normalizes spacing so equal queries share a cache entry", () => {
    expect(QueryPlan.normalize("  rust   tui\n")).toBe("rust tui");
  });
});

describe("PlannerPrompt", () => {
  test("shows the model examples that decode through the schema it answers with", () => {
    for (const example of PlannerPrompt.examples) {
      expect(decode(encode(example.output))).toEqual(example.output);
      expect(PlannerPrompt.system).toContain(`"${example.query}"`);
    }
  });

  // Search reads from the query's words whether each language is wanted or excluded, so a plan names both.
  test("shows the model a query that excludes a language, whose plan names it so search excludes it", () => {
    const excluded = PlannerPrompt.examples.flatMap(({ query, output }) =>
      Compile.compileQuery({
        query,
        planned: QueryPlan.fromPlannerOutput(query, output).filters,
        explicit: everything,
      }).stated.flatMap(({ group }) =>
        group._tag === "Closed" && group.mode === "exclude" ? group.any.map((atom) => formatAtom(atom)) : [],
      ),
    );
    expect(excluded.filter((atom) => /(^|:)lang:/.test(atom))).not.toEqual([]);
  });

  test("lists every registry metric for the model", () => {
    expect(PlannerPrompt.system).toContain("- active_contributors_growth_90d: Growth of active contributors");
  });

  // The version keys the plan cache and the answer cache. A change here empties both and is never a side effect of
  // the knowledge registry, so search keeps its own kind list.
  test("keeps the version that keys the plan and answer caches", () => {
    expect(PlannerPrompt.version).toBe(-897997569);
  });
});
