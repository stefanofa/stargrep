import { describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { type FacetFilter, type Route, route } from "../src/queries/search-statement.ts";

const dialect = new PgDialect();
const render = (part: SQL) => dialect.sqlToQuery(part).sql;

// Each part renders as its own name, so a route reads back as the filters that drive it.
const part = (name: string) => sql.raw(name);
const stated = (name: string, negated = false): FacetFilter => ({
  _tag: "Stated",
  negated,
  test: part(`${name}.test`),
  missing: part(`${name}.missing`),
  resolved: part(`${name}.resolved`),
  index: part(`${name}.index`),
  subjects: part(`${name}.subjects`),
});
const explicit = (
  name: string,
  options: { readonly negated?: boolean; readonly mixed?: boolean } = {},
): FacetFilter => ({
  _tag: "Explicit",
  negated: options.negated ?? false,
  test: part(`${name}.test`),
  missing: part(`${name}.missing`),
  drive: options.mixed ? null : { index: part(`${name}.index`), subjects: part(`${name}.subjects`) },
});

const shape = (result: Route) =>
  result._tag === "Probe"
    ? "probe"
    : `${result.anti ? "anti" : "index"} ${result.drivers
        .map((driver) => `${render(driver.index)}/${render(driver.subjects)}/${render(driver.ready)}`)
        .join(" ")}`;

describe("route", () => {
  test("drives the index shape by every positive stated group, ready once each resolves", () => {
    expect(shape(route([stated("a")]))).toBe("index a.index/a.subjects/a.resolved");
    expect(shape(route([stated("a"), stated("b", true), stated("c")]))).toBe(
      "index a.index/a.subjects/a.resolved c.index/c.subjects/c.resolved",
    );
  });

  test("lets a positive explicit group of subjects alone drive instead, always ready", () => {
    expect(shape(route([stated("a"), explicit("e"), explicit("f")]))).toBe("index e.index/e.subjects/true");
    expect(shape(route([explicit("e", { mixed: true }), stated("a")]))).toBe("index a.index/a.subjects/a.resolved");
  });

  test("takes the anti shape when every filter is a negated group that can drive", () => {
    expect(shape(route([stated("a", true), explicit("e", { negated: true })]))).toBe(
      "anti a.index/a.subjects/a.resolved e.index/e.subjects/true",
    );
  });

  test("probes when no filter can drive", () => {
    expect(shape(route([]))).toBe("probe");
    expect(shape(route([explicit("e", { mixed: true })]))).toBe("probe");
    expect(shape(route([stated("a", true), explicit("e", { negated: true, mixed: true })]))).toBe("probe");
  });
});
