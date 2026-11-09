import { describe, expect, test } from "bun:test";
import { empty } from "@stargrep/knowledge/decisions";
import { labelKey } from "@stargrep/knowledge/label-key";
import { planSeeds } from "@stargrep/knowledge/seeds";
import { exploreEntries } from "./explore.ts";

const topic = (name: string, label: string, aliases: ReadonlyArray<string> = []) => ({
  topic: name,
  label,
  definition: `about ${label}`,
  aliases,
});

describe("exploreEntries", () => {
  const [atproto, m3o, postgresql, nextjs] = exploreEntries({
    commit: "c8d7bc516928a4f17845b767884a80cc53affd57",
    topics: [
      topic("atproto", "AT Protocol"),
      topic("m3o", "Micro"),
      topic("postgresql", "PostgreSQL", ["postgres", "psql"]),
      topic("nextjs", "Next", ["next", "next-js"]),
    ],
  });

  test("trusts a reviewed display name that does not spell its topic", () => {
    expect(atproto).toMatchObject({ key: "atproto", label: "AT Protocol", reviewedLabel: true });
    expect(nextjs).not.toHaveProperty("reviewedLabel");
  });

  test("labels a topic whose display name drops its disambiguator with a reviewed label that spells the topic", () => {
    expect(m3o).toMatchObject({ key: "m3o", label: "M3O" });
    expect(m3o).not.toHaveProperty("reviewedLabel");
  });

  test("keeps a reviewed synonym apart from the aliases the spelling rule checks", () => {
    expect(postgresql).toMatchObject({ synonyms: ["postgres"], aliases: ["psql"] });
    expect(postgresql?.reason).toBe("GitHub explore topic postgresql (github/explore c8d7bc516928, CC-BY-4.0)");
  });

  const listed = exploreEntries({
    commit: "c8d7bc516928a4f17845b767884a80cc53affd57",
    topics: [
      topic("backbonejs", "Backbone.js", ["backbone"]),
      topic("casejs", "CASE", ["case", "case-app", "case-js"]),
      topic("edge", "Edge", ["microsoft-edge", "edge-browser"]),
      topic("swift-vapor", "Vapor"),
      topic("vapor", "Vapor"),
    ],
  });
  const planned = planSeeds({
    entries: listed,
    state: empty,
    holders: new Map(),
    subjects: new Map(),
    excluded: new Set(),
  });
  const claimed = planned.decisions.flatMap(({ decision }) =>
    decision._tag === "Create" ? [decision.label, ...decision.aliases].map((text) => labelKey(text)) : [],
  );

  test("leaves free the generic words a js spelling would claim, and the broad slug edge", () => {
    expect(listed.map((entry) => [entry.key, entry.label, entry.aliases, entry.synonyms])).toEqual([
      ["backbonejs", "Backbone.js", [], []],
      ["casejs", "CASE.js", ["case-app", "case-js"], []],
      ["microsoft-edge", "Microsoft Edge", ["microsoft-edge"], ["edge-browser"]],
      ["swift-vapor", "Vapor", [], []],
      ["vapor", "Vapor", [], []],
    ]);
    for (const word of ["case", "backbone", "edge"])
      expect([word, claimed.includes(labelKey(word))]).toEqual([word, false]);
    expect(claimed).toContain(labelKey("microsoft edge"));
  });

  test("plans one Vapor for swift-vapor and vapor", () => {
    expect(
      planned.decisions.filter(({ decision }) => decision._tag === "Create" && decision.label === "Vapor"),
    ).toEqual([expect.objectContaining({ decision: expect.objectContaining({ aliases: ["swift-vapor"] }) })]);
    expect(planned.skipped).toEqual([{ label: "Vapor", reason: "duplicate" }]);
  });
});
