import { describe, expect, test } from "bun:test";
import { formatAtom } from "./atom.ts";
import { type Claim, carry, decodeFacets, type PromptInput } from "./claims.ts";
import { empty, type KnowledgeState, type SplitEntry } from "./decisions.ts";
import { ReceiptId, Revision, SubjectId } from "./ids.ts";
import { type LabelKey, labelKey } from "./label-key.ts";
import {
  type LabelIndex,
  lookupKeys,
  type ProjectionInput,
  project,
  type RepoFacts,
  type RepoIdentity,
  type Rules,
} from "./projection.ts";
import { closed, type RoleId, roleIds, roles } from "./registry.ts";

const key = (term: string): LabelKey => {
  const result = labelKey(term);
  if (result === null) throw new Error(`no label key for ${term}`);
  return result;
};
const subject = (id: number) => SubjectId.make(id);

const repo: RepoIdentity = { id: 1, owner: "acme", name: "widget" };
const noFacts: RepoFacts = { language: null, license: null, topics: [] };

let ordinal = 0;
const claim = (role: RoleId, term: string, overrides: Partial<Claim> = {}): Claim => ({
  ordinal: ordinal++,
  role,
  term,
  key: key(term),
  quote: null,
  found: "term",
  ...overrides,
});

const labels = (entries: Record<string, number | ReadonlyArray<readonly [number, boolean]>>): LabelIndex =>
  new Map(
    Object.entries(entries).map(([term, value]) => [
      key(term),
      typeof value === "number"
        ? [{ subject: subject(value), isDefault: true }]
        : value.map(([id, isDefault]) => ({ subject: subject(id), isDefault })),
    ]),
  );

const noRules: Rules = empty;

const run = (input: Partial<ProjectionInput>) =>
  project({ repo, facts: noFacts, claims: [], labels: new Map(), rules: noRules, ...input });

const atomsOf = (input: Partial<ProjectionInput>) => run(input).atoms.map((atom) => formatAtom(atom));

const verdictOf = (input: Partial<ProjectionInput>) =>
  run(input).verdicts.map((verdict) => [verdict.outcome, verdict.reason, verdict.atom]);

describe("project: comparisons that name the repo itself", () => {
  // Appendix C of the data profile: the model called each of these repos an alternative to itself.
  const selfAlternatives = [
    ["Unitech/pm2", "pm2 alternative"],
    ["ag-grid/ag-grid", "ag-grid alternative"],
    ["localstack/localstack", "localstack alternative"],
    ["commaai/openpilot", "openpilot alternative"],
    ["DIYgod/RSSHub", "rsshub alternative"],
    ["mswjs/msw", "msw alternative"],
    ["jaredpalmer/tsdx", "tsdx alternative"],
    ["BetterTyped/react-zoom-pan-pinch", "react-zoom-pan-pinch alternative"],
    ["deezer/spleeter", "spleeter alternative"],
    ["remotion-dev/remotion", "remotion alternative"],
    ["QwikDev/partytown", "partytown alternative"],
    ["waydabber/BetterDisplay", "betterdisplay alternative"],
    ["vercel/satori", "satori alternative"],
    ["Vendicated/Vencord", "vencord alternative"],
    ["unkeyed/unkey", "unkey alternative"],
    ["firecrawl/firecrawl", "firecrawl alternative"],
    ["LeaVerou/style-observer", "style-observer alternative"],
    ["T3-Content/unduck", "unduck alternative"],
    ["jnsahaj/tweakcn", "tweakcn alternative"],
    ["farion1231/cc-switch", "cc-switch alternative"],
  ] as const;

  test("drops all 20 self-alternatives in the data profile, by name and by owner/name", () => {
    expect(selfAlternatives).toHaveLength(20);
    for (const [fullName, phrase] of selfAlternatives) {
      const [owner = "", name = ""] = fullName.split("/");
      const target = phrase.replace(/ alternative$/, "");
      const result = project({
        repo: { id: 7, owner, name },
        facts: noFacts,
        claims: [claim("alternative_to", target), claim("alternative_to", fullName), claim("alternative_to", "Zapier")],
        labels: labels({ [target]: 5, [fullName]: 6, zapier: 9 }),
        rules: noRules,
      });
      expect([fullName, result.atoms.map((atom) => formatAtom(atom))]).toEqual([fullName, ["alt:subject:9"]]);
      expect(result.verdicts.slice(0, 2).map((verdict) => verdict.reason)).toEqual([
        "self-comparison",
        "self-comparison",
      ]);
      expect(result.mints).toEqual([]);
    }
  });

  test("drops the repo's own name in replaced_by and built_with, and keeps it where a bare atom reaches it", () => {
    const own = { id: 2, owner: "tauri-apps", name: "tauri" };
    const result = project({
      repo: own,
      facts: noFacts,
      claims: [
        claim("built_with", "Tauri"),
        claim("replaced_by", "tauri", { quote: "use tauri", found: "quote" }),
        claim("about", "Tauri"),
        claim("for", "tauri"),
        claim("built_with", "Rust"),
      ],
      labels: labels({ tauri: 40 }),
      rules: noRules,
    });
    expect<unknown>(result.verdicts.map((verdict) => verdict.reason)).toEqual([
      "self-comparison",
      "self-comparison",
      "label",
      "label",
      "closed-value",
    ]);
    expect<unknown>(result.atoms.map((atom) => formatAtom(atom))).toEqual([
      "for:subject:40",
      "with:lang:rust",
      "about:subject:40",
    ]);
  });
});

describe("project: what never mints", () => {
  test("a reserved closed spelling in about, trait, or for is dropped, never minted, and never unresolved", () => {
    const result = run({
      claims: [
        claim("about", "Rust"),
        claim("about", "CLI"),
        claim("trait", "macOS"),
        claim("about", "deprecated"),
        claim("about", "tutorial"),
        claim("for", "library"),
        claim("alternative_to", "apps"),
      ],
    });
    expect<unknown>(result.verdicts.every((verdict) => verdict.reason === "reserved-label")).toBe(true);
    expect<unknown>([result.atoms, result.mints, result.unresolvedKeys]).toEqual([[], [], []]);
  });

  test("the keys revision 2 freed stay free: tui, postgresql, chrome, and ubuntu mint as subjects", () => {
    const result = run({
      claims: ["TUI", "PostgreSQL", "Chrome", "Ubuntu", "zlib"].map((term) => claim("about", term)),
    });
    expect<unknown>(result.mints.map((mint) => mint.key)).toEqual(["tui", "postgresql", "chrome", "ubuntu", "zlib"]);
  });

  test("noise labels mint like any term until a rejected seed owns the key, then resolve to it and never mint", () => {
    const noise = ["hacktoberfest", "open-source", "opensource", "oss", "awesome"];
    const unseeded = run({ claims: noise.map((term) => claim("about", term)) });
    expect<unknown>(unseeded.mints.map((mint) => mint.key)).toEqual([
      "hacktoberfest",
      "open source",
      "opensource",
      "oss",
      "awesome",
    ]);
    const seeded = run({
      claims: noise.map((term) => claim("about", term)),
      labels: labels({ hacktoberfest: 90, "open source": 91, opensource: 91, oss: 91, awesome: 92 }),
    });
    expect([seeded.mints, seeded.unresolvedKeys]).toEqual([[], []]);
    expect(seeded.atoms.map((atom) => formatAtom(atom))).toEqual([
      "about:subject:90",
      "about:subject:91",
      "about:subject:92",
    ]);
  });

  test("a topic with no label stays unresolved and never mints", () => {
    const result = run({ facts: { ...noFacts, topics: ["acme-widget-protocol", "Chrome"] } });
    expect([result.atoms, result.mints]).toEqual([[], []]);
    expect<unknown>(result.unresolvedKeys).toEqual(["acme widget protocol", "chrome"]);
    expect(result.verdicts.map((verdict) => verdict.reason)).toEqual(["topic-unknown", "topic-unknown"]);
  });
});

describe("project: closed values", () => {
  test("for and the comparison roles try languages and platforms before subjects", () => {
    expect(
      atomsOf({
        claims: [
          claim("for", "Node.js"),
          claim("for", "Python"),
          claim("for", "WebAssembly"),
          claim("alternative_to", "Node.js"),
          claim("alternative_to", "golang"),
          claim("replaced_by", "Deno", { quote: "use Deno instead", found: "quote" }),
          claim("built_with", "TypeScript"),
          claim("built_with", "Bun"),
        ],
      }),
    ).toEqual([
      "for:lang:python",
      "for:platform:node",
      "for:platform:wasm",
      "with:lang:typescript",
      "with:platform:bun",
      "alt:lang:go",
      "alt:platform:node",
      "replaced-by:platform:deno",
    ]);
  });

  test("an impliedBy name resolves only in a role that accepts nothing but its dimension", () => {
    const result = run({
      claims: [
        claim("runs_on", "Chrome"),
        claim("for", "Chrome"),
        claim("alternative_to", "Chrome"),
        claim("is", "SDK"),
      ],
    });
    expect(result.atoms.map((atom) => formatAtom(atom))).toEqual(["kind:library", "runs-on:platform:browser"]);
    expect<unknown>(result.mints).toEqual([{ key: "chrome", label: "Chrome" }]);
    expect(result.verdicts.map((verdict) => verdict.reason)).toEqual(["implied", "minted", "minted", "implied"]);
  });

  test("every impliedBy name in the registry resolves to its value in the role that accepts only its dimension", () => {
    let names = 0;
    for (const [dim, values] of Object.entries(closed)) {
      const role = roleIds.find((id) => roles[id].accepts.length === 1 && roles[id].accepts[0] === dim);
      for (const value of values) {
        for (const name of value.impliedBy) {
          if (role === undefined) throw new Error(`no role accepts only ${dim}`);
          const result = run({ claims: [claim(role, name, { quote: name, found: "quote" })] });
          expect<unknown>([dim, name, result.atoms.map((atom) => atom.value)]).toEqual([
            dim,
            name,
            [{ dim, id: value.id }],
          ]);
          expect(result.verdicts[0]?.reason).toBe("implied");
          names++;
        }
      }
    }
    expect(names).toBe(
      closed.kind.flatMap((v) => v.impliedBy).length +
        closed.language.flatMap((v) => v.impliedBy).length +
        closed.platform.flatMap((v) => v.impliedBy).length,
    );
  });

  test("a closed role's term that resolves nowhere is dropped and never minted", () => {
    const result = run({
      claims: [claim("runs_on", "Docker"), claim("is", "codemod"), claim("written_in", "Brainfuck")],
    });
    expect(result.verdicts.map((verdict) => verdict.reason)).toEqual([
      "unresolved-closed",
      "unresolved-closed",
      "unresolved-closed",
    ]);
    expect([result.atoms, result.mints, result.unresolvedKeys]).toEqual([[], [], []]);
  });

  test("status and replaced_by need a quote found in the input, and other roles never do", () => {
    const result = run({
      claims: [
        claim("status", "deprecated", { found: "term" }),
        claim("replaced_by", "ratatui", { found: "neither" }),
        claim("status", "unmaintained", { quote: "no longer maintained", found: "quote" }),
        claim("alternative_to", "Slack", { found: "neither" }),
      ],
      labels: labels({ ratatui: 3, slack: 4 }),
    });
    expect(result.verdicts.map((verdict) => verdict.reason)).toEqual([
      "quote-required",
      "quote-required",
      "closed-value",
      "label",
    ]);
    expect(result.atoms.map((atom) => formatAtom(atom))).toEqual(["status:unmaintained", "alt:subject:4"]);
  });

  test("each role keeps at most its max atoms, in the model's order, with the primary kind first", () => {
    const result = run({
      claims: [claim("is", "CLI"), claim("is", "library"), claim("is", "app"), claim("is", "CLIs")],
    });
    expect(result.atoms.map((atom) => formatAtom(atom))).toEqual(["kind:cli", "kind:library"]);
    expect(result.verdicts.map((verdict) => [verdict.outcome, verdict.reason])).toEqual([
      ["used", "closed-value"],
      ["used", "closed-value"],
      ["dropped", "over-limit"],
      ["used", "closed-value"],
    ]);
  });

  test("the primary kind stays first even when it sorts after the second", () => {
    expect(atomsOf({ claims: [claim("is", "library"), claim("is", "app")] })).toEqual(["kind:library", "kind:app"]);
  });
});

describe("project: GitHub facts", () => {
  test("the primary language is written_in, the SPDX license is licensed, and topics are for, runs_on, or tagged", () => {
    const result = run({
      facts: {
        language: "Jupyter Notebook",
        license: "Apache-2.0",
        topics: ["python", "golang", "linux", "nodejs", "cli", "deprecated", "tui", "web-scraping", "unheard-of"],
      },
      labels: labels({ tui: 12 }),
    });
    expect(result.atoms.map((atom) => formatAtom(atom))).toEqual([
      "written-in:lang:jupyter-notebook",
      "runs-on:platform:linux",
      "runs-on:platform:node",
      "for:lang:go",
      "for:lang:python",
      "license:Apache-2.0",
      "tagged:subject:12",
    ]);
    expect<unknown>(result.unresolvedKeys).toEqual(["unheard of", "web scraping"]);
    expect(result.mints).toEqual([]);
  });

  test("a license matches its SPDX id exactly, case included", () => {
    expect(verdictOf({ facts: { ...noFacts, license: "mit" } })).toEqual([["dropped", "license-unknown", null]]);
    expect(atomsOf({ facts: { ...noFacts, license: "MIT" } })).toEqual(["license:MIT"]);
  });

  test("every language prod holds today resolves, and an unknown one or a missing license gives no atom", () => {
    const prodLanguages = [
      "TypeScript",
      "JavaScript",
      "Python",
      "Rust",
      "Swift",
      "Go",
      "C++",
      "C",
      "HTML",
      "Shell",
      "CSS",
      "MDX",
      "Java",
      "Jupyter Notebook",
      "Kotlin",
      "Solidity",
      "Ruby",
      "Markdown",
      "Elixir",
      "Zig",
      "PHP",
      "Objective-C",
      "Svelte",
      "Astro",
      "C#",
      "R",
      "Lua",
      "Jinja",
      "Objective-C++",
      "Dart",
      "Crystal",
      "Scala",
      "Clojure",
      "Luau",
      "Blade",
      "SCSS",
      "SQL",
      "Vim Script",
      "CoffeeScript",
      "Makefile",
      "Stata",
      "Nix",
      "Pkl",
      "PowerShell",
      "Gleam",
      "Nushell",
      "Assembly",
    ];
    for (const language of prodLanguages) {
      expect([language, atomsOf({ facts: { ...noFacts, language } }).length]).toEqual([language, 1]);
    }
    expect(verdictOf({ facts: { language: "Dockerfile", license: "NOASSERTION", topics: [] } })).toEqual([
      ["dropped", "unresolved-closed", null],
      ["dropped", "license-unknown", null],
    ]);
  });

  test("facts count toward a role's max after the receipt's claims", () => {
    const result = run({
      claims: [claim("written_in", "Rust"), claim("written_in", "C"), claim("written_in", "Python")],
      facts: { ...noFacts, language: "Go" },
    });
    expect(result.atoms.map((atom) => formatAtom(atom))).toEqual([
      "written-in:lang:c",
      "written-in:lang:python",
      "written-in:lang:rust",
    ]);
    expect(result.verdicts.at(-1)).toEqual({
      claim: { from: "facts", field: "language", index: 0 },
      outcome: "dropped",
      reason: "over-limit",
      atom: "written-in:lang:go",
    });
  });
});

describe("project: subjects and the curated rules", () => {
  const entry = (into: number, rule: Partial<SplitEntry["rule"]>, at = 1): SplitEntry => ({
    revision: Revision.make(at),
    into: subject(into),
    rule: { labels: [], terms: [], repos: [], ...rule },
  });
  const rules = (overrides: Partial<KnowledgeState>): Rules => ({ ...empty, ...overrides });

  test("a key with no label mints in a minting role and is recorded as unresolved until it has one", () => {
    const result = run({ claims: [claim("about", "terminal UI"), claim("trait", "Terminal-UI")] });
    expect<unknown>(result.mints).toEqual([{ key: "terminal ui", label: "terminal UI" }]);
    expect<unknown>(result.unresolvedKeys).toEqual(["terminal ui"]);
    expect(result.atoms).toEqual([]);
    expect(atomsOf({ claims: [claim("about", "terminal UI")], labels: labels({ "terminal ui": 8 }) })).toEqual([
      "about:subject:8",
    ]);
  });

  test("a claim past its role's max is over-limit and mints nothing, before the mint and after it", () => {
    const terms = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
    const claims = terms.map((term) => claim("about", term));
    const before = run({ claims: [...claims, claim("about", "terminal UI")], labels: labels({ "terminal ui": 50 }) });
    expect(before.mints.map((mint) => mint.label)).toEqual(terms.slice(0, 8));
    expect(before.verdicts.slice(8).map((verdict) => [verdict.outcome, verdict.reason])).toEqual([
      ["dropped", "over-limit"],
      ["dropped", "over-limit"],
    ]);
    const minted = labels({
      ...Object.fromEntries(terms.slice(0, 8).map((term, index) => [term, 60 + index])),
      "terminal ui": 50,
    });
    const after = run({ claims: [...claims, claim("about", "terminal UI")], labels: minted });
    expect(after.mints).toEqual([]);
    expect(after.atoms).toHaveLength(8);
    expect(after.verdicts.map((verdict) => verdict.reason)).toEqual(
      before.verdicts.map((verdict, index) => (index < 8 ? "label" : verdict.reason)),
    );
  });

  test("a repeated key waiting on its mint holds one slot, not two", () => {
    const result = run({
      claims: [claim("trait", "offline"), claim("trait", "Offline"), claim("trait", "local-first")],
    });
    expect<unknown>(result.mints.map((mint) => mint.key)).toEqual(["offline", "local first"]);
  });

  test("the default sense wins over other senses of a key, and only a split rule picks another", () => {
    expect(
      verdictOf({
        claims: [claim("about", "agent")],
        labels: labels({
          agent: [
            [5, false],
            [4, true],
          ],
        }),
      }),
    ).toEqual([["used", "ambiguous-default", "about:subject:4"]]);
  });

  test("a split rule moves a claim by its label key, by every word of a terms entry in its quote or term, or by repo", () => {
    const splits = new Map([
      [subject(4), [entry(20, { labels: [key("user agent")] }), entry(21, { terms: [["browser", "user-agent"]] }, 2)]],
    ]);
    const index = labels({ agent: 4, "user agent": 4 });
    const projectClaim = (c: Claim, id = 1) =>
      project({
        repo: { ...repo, id },
        facts: noFacts,
        claims: [c],
        labels: index,
        rules: rules({ splits }),
      }).atoms.map((atom) => formatAtom(atom));
    expect(projectClaim(claim("about", "user agent"))).toEqual(["about:subject:20"]);
    expect(
      projectClaim(claim("about", "agent", { quote: "parses the Browser User-Agent header", found: "quote" })),
    ).toEqual(["about:subject:21"]);
    expect(projectClaim(claim("about", "agent", { quote: "an AI agent for browsers", found: "quote" }))).toEqual([
      "about:subject:4",
    ]);
    const pinned = new Map([[subject(4), [entry(22, { repos: [77] })]]]);
    expect(
      project({
        repo: { ...repo, id: 77 },
        facts: noFacts,
        claims: [claim("about", "agent")],
        labels: index,
        rules: rules({ splits: pinned }),
      }).atoms.map((atom) => formatAtom(atom)),
    ).toEqual(["about:subject:22"]);
  });

  test("split rules nest, and the canonical survivor's rules catch a claim on a merged-away ID", () => {
    const splits = new Map([
      [subject(4), [entry(20, { terms: [["browser"]] })]],
      [subject(20), [entry(30, { terms: [["mobile"]] }, 2)]],
    ]);
    const canonical = new Map([[subject(3), subject(4)]]);
    expect(
      atomsOf({
        claims: [claim("about", "user agents", { quote: "mobile browser strings", found: "quote" })],
        labels: labels({ "user agents": 3 }),
        rules: rules({ splits, canonical }),
      }),
    ).toEqual(["about:subject:30"]);
  });

  test("when two split rules match one claim, the older one wins", () => {
    const splits = new Map([
      [subject(4), [entry(31, { terms: [["browser"]] }, 2), entry(30, { terms: [["browser"]] }, 1)]],
    ]);
    expect(
      atomsOf({
        claims: [claim("about", "agent", { quote: "browser agent", found: "quote" })],
        labels: labels({ agent: 4 }),
        rules: rules({ splits }),
      }),
    ).toEqual(["about:subject:30"]);
  });

  test("a topic that matches a split subject follows its rules too", () => {
    const splits = new Map([[subject(4), [entry(20, { repos: [1] })]]]);
    expect(
      atomsOf({ facts: { ...noFacts, topics: ["agent"] }, labels: labels({ agent: 4 }), rules: rules({ splits }) }),
    ).toEqual(["tagged:subject:20"]);
  });

  test("corrections apply last: a present one is kept first in its role, and an absent one removes the atom", () => {
    const corrections = new Map([
      [
        1,
        [
          { atom: { role: "is" as const, value: { dim: "kind" as const, id: "framework" as const } }, present: true },
          {
            atom: { role: "licensed" as const, value: { dim: "license" as const, id: "MIT" as const } },
            present: false,
          },
          {
            atom: { role: "alternative_to" as const, value: { dim: "subject" as const, id: subject(70) } },
            present: true,
          },
          { atom: { role: "about" as const, value: { dim: "subject" as const, id: subject(8) } }, present: false },
        ],
      ],
    ]);
    const result = run({
      claims: [claim("is", "library"), claim("is", "app"), claim("about", "terminal UI")],
      facts: { ...noFacts, license: "MIT" },
      labels: labels({ "terminal ui": 8 }),
      rules: rules({ corrections }),
    });
    expect(result.atoms.map((atom) => formatAtom(atom))).toEqual(["kind:framework", "kind:library", "alt:subject:70"]);
    expect(result.verdicts.map((verdict) => [verdict.outcome, verdict.reason, verdict.atom])).toEqual([
      ["used", "closed-value", "kind:library"],
      ["dropped", "over-limit", "kind:app"],
      ["dropped", "corrected-out", "about:subject:8"],
      ["dropped", "corrected-out", "license:MIT"],
      ["used", "corrected-in", "kind:framework"],
      ["dropped", "corrected-out", "license:MIT"],
      ["used", "corrected-in", "alt:subject:70"],
      ["dropped", "corrected-out", "about:subject:8"],
    ]);
  });

  test("a carried receipt projects to the atoms its previous receipt gave", () => {
    const input: PromptInput = { fullName: "acme/widget", description: "A terminal UI kit", topics: [], readme: "" };
    const previous = decodeFacets(
      [
        { role: "is", term: "library" },
        { role: "about", term: "terminal UI" },
      ],
      input,
    );
    const carried = carry(decodeFacets(undefined, input), {
      id: ReceiptId.make("00000000-0000-4000-8000-000000000002"),
      claims: previous.claims,
    });
    const index = labels({ "terminal ui": 8 });
    expect(atomsOf({ claims: carried.claims, labels: index })).toEqual(
      atomsOf({ claims: previous.claims, labels: index }),
    );
    expect(atomsOf({ claims: carried.claims, labels: index })).toEqual(["kind:library", "about:subject:8"]);
  });

  test("lookupKeys names every key projection looks up, so the caller loads exactly those labels", () => {
    const claims = [claim("about", "terminal UI"), claim("is", "library")];
    const facts = { ...noFacts, topics: ["TUI", "***"] };
    expect<unknown>(lookupKeys(claims, facts)).toEqual(["terminal ui", "library", "tui"]);
  });

  test("the same inputs in any claim or topic order give the same atoms", () => {
    const claims = [claim("about", "b"), claim("about", "a"), claim("for", "Python"), claim("trait", "offline")];
    const index = labels({ a: 3, b: 2, offline: 9 });
    const facts = { language: "Rust", license: "MIT", topics: ["linux", "macos", "a"] };
    const reversed = { ...facts, topics: [...facts.topics].reverse() };
    expect(atomsOf({ claims, labels: index, facts })).toEqual(
      atomsOf({ claims: [...claims].reverse(), labels: index, facts: reversed }),
    );
  });
});
