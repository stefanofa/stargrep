import { describe, expect, test } from "bun:test";
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
});
