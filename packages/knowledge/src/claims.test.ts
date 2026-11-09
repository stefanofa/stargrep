import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import {
  Claim,
  type DecodedFacets,
  decodeFacets,
  legacyFacets,
  maxItems,
  modelRoles,
  type PromptInput,
} from "./claims.ts";
import fixture from "./evidence-text.fixture.json";
import type { LabelKey } from "./label-key.ts";
import { roleIds, roles } from "./registry.ts";

const input: PromptInput = {
  fullName: "ratatui/ratatui",
  description: "A Rust crate for cooking up terminal user interfaces",
  topics: ["tui", "rust", "terminal"],
  readme: "Ratatui was forked from the [tui-rs] crate in 2023.\n\nIt is **no longer maintained** by its first author.",
};

const lanesOf = (decoded: DecodedFacets) => Object.entries(decoded.lanes).filter(([, state]) => state !== "complete");
const decodeClaim = Schema.decodeUnknownSync(Claim);

describe("decodeFacets", () => {
  test("lanes are exactly the roles with a prompt line", () => {
    expect<unknown>([...modelRoles]).toEqual(roleIds.filter((role) => roles[role].prompt !== null));
  });

  test("valid facts: every lane complete and every claim kept, with the quote found after markdown is stripped", () => {
    const decoded = decodeFacets(
      [
        { role: "is", term: "library" },
        { role: "written_in", term: "Rust" },
        { role: "about", term: "terminal user interfaces" },
        { role: "alternative_to", term: "tui-rs", quote: "forked from the tui-rs crate in 2023" },
      ],
      input,
    );
    expect<unknown>(lanesOf(decoded)).toEqual([]);
    expect<unknown>(decoded.dropped).toEqual([]);
    expect<unknown>(decoded.claims.map((claim) => [claim.ordinal, claim.role, claim.key, claim.found])).toEqual([
      [0, "is", "library", "neither"],
      [1, "written_in", "rust", "term"],
      [2, "about", "terminal user interfaces", "term"],
      [3, "alternative_to", "tui rs", "quote"],
    ]);
    for (const claim of decoded.claims) expect(decodeClaim(claim)).toEqual(claim);
  });

  test("a list that is absent, null, or not an array makes every lane missing and keeps no claim", () => {
    for (const raw of [undefined, null, "is: library", { role: "is", term: "library" }, 3]) {
      const decoded = decodeFacets(raw, input);
      expect(decoded.claims).toEqual([]);
      expect(Object.values(decoded.lanes)).toEqual(modelRoles.map(() => "missing"));
    }
  });

  test("an unknown role, or an item that is not an object, turns every lane invalid and keeps every readable fact", () => {
    for (const bad of [{ role: "uses", term: "React" }, { role: "tagged", term: "react" }, "about: react", null]) {
      const decoded = decodeFacets([{ role: "about", term: "web scraping" }, bad, { role: "is", term: "cli" }], input);
      expect(decoded.claims.map((claim) => claim.term)).toEqual(["web scraping", "cli"]);
      expect(Object.values(decoded.lanes)).toEqual(modelRoles.map(() => "invalid"));
      expect(decoded.dropped).toEqual([
        { ordinal: 1, issue: typeof bad === "object" && bad !== null ? "unknown-role" : "not-an-object" },
      ]);
    }
  });

  test("an empty term, a term over 80 characters, or one with no label key turns only its own lane invalid", () => {
    const decoded = decodeFacets(
      [
        { role: "about", term: "   " },
        { role: "trait", term: "x".repeat(81) },
        { role: "for", term: "***" },
        { role: "for", quote: "no term at all" },
        { role: "is", term: "library" },
      ],
      input,
    );
    expect(decoded.claims.map((claim) => claim.term)).toEqual(["library"]);
    expect(lanesOf(decoded)).toEqual([
      ["for", "invalid"],
      ["about", "invalid"],
      ["trait", "invalid"],
    ]);
    expect(decoded.dropped).toEqual([
      { ordinal: 0, issue: "empty-term" },
      { ordinal: 1, issue: "too-long" },
      { ordinal: 2, issue: "empty-term" },
      { ordinal: 3, issue: "empty-term" },
    ]);
  });

  test("a term NFKC lengthens past 80 characters has no label key, so only its lane turns invalid", () => {
    const ligatures = "ﬀ".repeat(80);
    expect(ligatures).toHaveLength(80);
    expect(ligatures.normalize("NFKC")).toHaveLength(160);
    const decoded = decodeFacets(
      [
        { role: "about", term: ligatures },
        { role: "about", term: "terminal UI" },
      ],
      input,
    );
    expect(decoded.claims.map((claim) => claim.term)).toEqual(["terminal UI"]);
    expect(decoded.dropped).toEqual([{ ordinal: 0, issue: "too-long" }]);
    expect(lanesOf(decoded)).toEqual([["about", "invalid"]]);
  });

  test("more facts than a role's max all decode, since role limits are projection's", () => {
    const decoded = decodeFacets(
      ["app", "cli", "library"].map((term) => ({ role: "is", term })),
      input,
    );
    expect(decoded.claims).toHaveLength(3);
    expect(lanesOf(decoded)).toEqual([]);
  });

  test("keeps a term of exactly 80 characters", () => {
    const term = "x".repeat(80);
    const decoded = decodeFacets([{ role: "about", term }], input);
    expect([decoded.claims.map((claim) => claim.term), decoded.dropped]).toEqual([[term], []]);
  });

  test("marks the cut at the 33rd item and not at the 32nd", () => {
    const items = (length: number) => Array.from({ length }, (_, index) => ({ role: "about", term: `topic ${index}` }));
    expect(decodeFacets(items(maxItems), input).dropped).toEqual([]);
    expect(decodeFacets(items(maxItems + 1), input).dropped).toEqual([{ ordinal: maxItems, issue: "over-limit" }]);
  });

  test("reads at most 32 items and marks the cut once", () => {
    const raw = Array.from({ length: 40 }, (_, index) => ({ role: "about", term: `topic ${index}` }));
    const decoded = decodeFacets(raw, input);
    expect(decoded.claims).toHaveLength(maxItems);
    expect(decoded.dropped).toEqual([{ ordinal: maxItems, issue: "over-limit" }]);
    expect(lanesOf(decoded)).toEqual([]);
  });

  test("a status or replaced_by quote is found only where the input says it, so projection can refuse the rest", () => {
    const decoded = decodeFacets(
      [
        { role: "status", term: "unmaintained", quote: "**no longer maintained**" },
        { role: "status", term: "deprecated", quote: "deprecated in favor of ratatui" },
        { role: "replaced_by", term: "tui-rs" },
      ],
      input,
    );
    expect(decoded.claims.map((claim) => claim.found)).toEqual(["quote", "neither", "term"]);
    expect(lanesOf(decoded)).toEqual([]);
  });

  test("a quote of markup alone has empty evidence text, which the quote gate refuses", () => {
    for (const quote of ["**", "`` ``", "> ", "| |", "[]()"]) {
      const [claim] = decodeFacets([{ role: "status", term: "abandoned", quote }], input).claims;
      expect([quote, claim?.found]).toEqual([quote, "neither"]);
    }
  });

  test("a line label is not evidence", () => {
    const [claim] = decodeFacets([{ role: "about", term: "slack", quote: "Topics: slack" }], {
      ...input,
      topics: ["slack"],
    }).claims;
    expect(claim?.found).toBe("term");
  });

  test("finds the pilot's 59 rendered quotes and refuses its 6 others, against the input each was quoting", () => {
    const found = fixture.map((row) => {
      const [claim] = decodeFacets([{ role: "status", term: "deprecated", quote: row.quote }], {
        fullName: row.repo,
        description: "",
        topics: [],
        readme: row.input,
      }).claims;
      return claim?.found === "quote";
    });
    expect(found).toEqual(fixture.map((row) => row.matches));
  });

  test("keeps model text storable: lone surrogates become U+FFFD, U+0000 goes, and a long quote is cut on a code point", () => {
    const [surrogate, nul] = decodeFacets(
      [
        { role: "about", term: "ab\uD800c", quote: `${"q".repeat(239)}😀tail` },
        { role: "about", term: "dash\u0000boards", quote: "widget\u0000" },
      ],
      input,
    ).claims;
    expect(surrogate?.term).toBe("ab\uFFFDc");
    expect(surrogate?.quote).toBe("q".repeat(239));
    expect([nul?.term, nul?.key, nul?.quote]).toEqual(["dashboards", "dashboards", "widget"]);
    expect(JSON.stringify([surrogate, nul])).not.toMatch(/\\u0000|\\ud800/i);
  });
});

describe("legacyFacets", () => {
  test("the kind is the only claim, the only answered lane, and is not found in any prompt", () => {
    const decoded = legacyFacets({ kind: "cli" });
    expect(decoded.claims).toEqual([
      { ordinal: 0, role: "is", term: "cli", key: "cli" as LabelKey, quote: null, found: "neither" },
    ]);
    expect(decoded.dropped).toEqual([]);
    expect<Record<string, string>>(decoded.lanes).toEqual({
      ...Object.fromEntries(modelRoles.map((role) => [role, "missing"])),
      is: "complete",
    });
  });

  test("other and a missing kind give no claim, and the is lane stays answered", () => {
    for (const kind of ["other", null]) {
      const decoded = legacyFacets({ kind });
      expect(decoded.claims).toEqual([]);
      expect(decoded.lanes.is).toBe("complete");
    }
  });
});
