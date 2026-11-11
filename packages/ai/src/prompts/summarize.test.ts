import { describe, expect, test } from "bun:test";
import * as it from "@stargrep/testing";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Fake from "../fake.ts";
import * as Models from "../models.ts";
import * as SummarizeFake from "./summarize.fake.ts";
import * as Summarize from "./summarize.ts";

const repo: Summarize.RepoFacts = {
  fullName: "ratatui/ratatui",
  description: "A Rust crate for cooking up terminal user interfaces",
  topics: ["rust", "tui"],
  language: "Rust",
  readme: "# Ratatui\n\nRatatui builds rich terminal user interfaces and dashboards.",
};

// Every tag name the README cleaner strips, so dropping one from its list changes the digest.
const htmlTags = (
  "a abbr b blockquote br center code dd del details div dl dt em figcaption figure font g h1 h2 h3 h4 h5 h6 hr i img " +
  "ins kbd li ol p path picture pre s section small source span strong sub summary sup svg table tbody td tfoot th " +
  "thead tr tt u ul video"
).split(" ");

describe("summary recipe", () => {
  // A summary made by another model, prompt, output schema, or reasoning setting is stale, and only a recipe bump makes
  // it due again. Bump summaryRecipe in models.ts with the migration it needs, then record the new digest. A change that
  // leaves summaries as good as before may keep the recipe and only record the digest.
  it.effect("pins the recipe to the model, prompt, output schema, and reasoning setting that make a summary", () =>
    Effect.gen(function* () {
      const digest = yield* Digest.Digest;
      const made = JSON.stringify([
        Models.summaryModel,
        Summarize.reasoning,
        Summarize.system,
        Summarize.promptOf({
          ...repo,
          readme: [
            repo.readme,
            "<!-- badges -->",
            '![logo](logo.png) <p align="center"><img src="x.png"></p> [](empty) <me@example.com>',
            '```html\n<p align="center"><img src="shot.png"></p>\n![shot](shot.png)\n```',
            "[docs]: https://ratatui.rs",
            "Write `<br>` for a line break.\uFFFD",
            "Ratatui widgets. ".repeat(2_000),
          ].join("\n\n"),
        }).text,
        Summarize.promptOf({ ...repo, readme: `${"Mostly text. ".repeat(10)}${"\uFFFD".repeat(5)}` }).text,
        Summarize.promptOf({
          ...repo,
          readme: [
            htmlTags.map((tag) => `<${tag} class="x">${tag}</${tag}>`).join(" "),
            '~~~\n<img src="tilde.png">\n~~~',
            '   ```\n<img src="indented.png">\n   ```',
            '```\n```js\n<img src="inner.png">\n```',
            "![logo][logo]",
            "Line with trailing spaces   \nNext line",
            "<!-- never closed\nStill here",
          ].join("\n\n"),
        }).text,
        Summarize.promptOf({ ...repo, readme: "# Tool\n\nUse it.\u0000" }).text,
        Summarize.promptOf({ ...repo, readme: '<img src="x">\n\n---' }).text,
        Summarize.providerSchema,
      ]);
      expect({
        recipe: Models.summaryRecipe,
        digest: yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(made)),
      }).toEqual({ recipe: 4, digest: "694e5310ed4951c5fc3dd654275cdeebfb590d5ba63bee3a9023a3743d2f9741" });
    }).pipe(Effect.provide(Digest.layerWebCrypto)),
  );
});

describe("summarize", () => {
  it.effect("trims a long README before the call", () => {
    const prompts: Array<string> = [];
    const layer = Fake.layerTextGeneration((prompt) => {
      prompts.push(prompt);
      return SummarizeFake.respond(prompt);
    });
    return Summarize.summarize({ ...repo, readme: "x".repeat(300_000) }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(prompts[0]?.length).toBeLessThan(Summarize.readmeLimit + 500);
          expect(prompts[0]?.endsWith("[README truncated]")).toBe(true);
        }),
      ),
      Effect.provide(layer),
    );
  });

  it.effect("the fake responder answers every repo with a valid RepoSummary", () =>
    Effect.gen(function* () {
      const summary = yield* Summarize.summarize(repo);
      expect(Schema.is(Summarize.RepoSummary)(summary)).toBe(true);
      expect(summary.summary).toContain("terminal user interfaces");
      expect(summary.keywords).toEqual(["rust", "tui"]);
    }).pipe(Effect.provide(Fake.layerTextGeneration(SummarizeFake.respond))),
  );
});

describe("summarize: facts", () => {
  const answering = (facets: unknown, summary = "A Rust library for terminal user interfaces.") =>
    Fake.layerTextGeneration(() => ({ summary, keywords: ["tui"], ...(facets === undefined ? {} : { facets }) }));
  const forked = {
    ...repo,
    readme: "<!-- deprecated -->\n# Ratatui\n\nRatatui was forked from the [tui-rs] crate in 2023.",
  };
  const notComplete = (summary: Summarize.RepoSummary) =>
    Object.entries(summary.facets.lanes).filter(([, state]) => state !== "complete");

  it.effect("decodes each fact against the text the prompt carried, after markdown is stripped from both", () =>
    Effect.gen(function* () {
      const summary = yield* Summarize.summarize(forked);
      expect(notComplete(summary)).toEqual([]);
      expect<unknown>(summary.facets.claims.map((claim) => [claim.role, claim.key, claim.found])).toEqual([
        ["is", "library", "neither"],
        ["alternative_to", "tui rs", "quote"],
        ["status", "deprecated", "neither"],
      ]);
    }).pipe(
      Effect.provide(
        answering([
          { role: "is", term: "library" },
          { role: "alternative_to", term: "tui-rs", quote: "forked from the tui-rs crate in 2023" },
          { role: "status", term: "deprecated", quote: "deprecated" },
        ]),
      ),
    ),
  );

  it.effect("keeps the summary whatever the facts hold", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [unknown, string]> = [
        [undefined, "missing"],
        ["is: library", "missing"],
        [
          [
            { role: "is", term: "library" },
            { role: "maintainer", term: "someone" },
          ],
          "invalid",
        ],
        [
          [
            { role: "is", term: "" },
            { role: "about", term: "dashboards" },
          ],
          "is invalid",
        ],
      ];
      for (const [facets, expected] of cases) {
        const summary = yield* Summarize.summarize(forked).pipe(Effect.provide(answering(facets)));
        expect(summary.summary).toBe("A Rust library for terminal user interfaces.");
        const lanes = new Set(Object.values(summary.facets.lanes));
        const described =
          lanes.size === 1
            ? [...lanes][0]
            : `${notComplete(summary)
                .map(([role]) => role)
                .join(" ")} invalid`;
        expect([facets, described]).toEqual([facets, expected]);
      }
    }),
  );

  it.effect("fails only an answer whose summary does not decode", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Summarize.summarize(forked).pipe(Effect.provide(answering([], ""))));
      expect(error._tag).toBe("AiOutputInvalid");
    }),
  );
});

describe("the stand-in", () => {
  const prompt = (facts: Partial<Summarize.RepoFacts>) => Summarize.promptOf({ ...repo, ...facts }).text;
  const facts = (answer: SummarizeFake.Answer) => answer.facets.map((fact) => [fact.role, fact.term, fact.quote]);

  test("states the description's kind and platform words, the language, each topic, an alternative, and a deprecation", () => {
    const answer = SummarizeFake.respond(
      prompt({
        description: "A deprecated CLI and library for macOS, an open source alternative to Google Analytics",
        topics: ["analytics", "privacy"],
        language: "Go",
        readme: "# Tool",
      }),
    );
    expect(facts(answer)).toEqual([
      ["is", "CLI", undefined],
      ["is", "library", undefined],
      ["written_in", "Go", undefined],
      ["runs_on", "macOS", undefined],
      ["about", "analytics", "analytics"],
      ["about", "privacy", "privacy"],
      ["alternative_to", "Google Analytics", "alternative to Google Analytics"],
      [
        "status",
        "deprecated",
        "A deprecated CLI and library for macOS, an open source alternative to Google Analytics",
      ],
    ]);
  });

  test("never guesses a kind, a language, or a status the text lacks", () => {
    const answer = SummarizeFake.respond(
      prompt({ description: "Helps teams ship faster", topics: [], language: null, readme: null }),
    );
    expect(facts(answer)).toEqual([]);
    expect(answer.summary).toBe("Helps teams ship faster");
  });

  test("reads a named alternative and a deprecation at the top of the README", () => {
    const answer = SummarizeFake.respond(
      prompt({
        description: "Open source Notion alternative",
        topics: [],
        readme: "# Tool\n\n**This package is deprecated.** Use the new one.\n\nMore text.",
      }),
    );
    expect(facts(answer).slice(-2)).toEqual([
      ["alternative_to", "Notion", "Notion alternative"],
      ["status", "deprecated", "**This package is deprecated.** Use the new one."],
    ]);
  });

  it.effect("every stand-in fact decodes, and its quotes are found in the prompt it read", () =>
    Effect.gen(function* () {
      const summary = yield* Summarize.summarize({
        ...repo,
        description: "A deprecated Rust library, an alternative to tui-rs",
        readme: "# Ratatui\n\nRatatui is deprecated.",
      });
      expect(new Set(Object.values(summary.facets.lanes))).toEqual(new Set(["complete"]));
      expect(summary.facets.dropped).toEqual([]);
      expect(summary.facets.claims.filter((claim) => claim.quote !== null).map((claim) => claim.found)).toEqual([
        "quote",
        "quote",
        "quote",
        "quote",
      ]);
    }).pipe(Effect.provide(Fake.layerTextGeneration(SummarizeFake.respond))),
  );
});

describe("readmeText", () => {
  test("drops comments, badges, images, link definitions, and HTML tags but keeps the words", () => {
    const readme = [
      "<!-- hidden -->",
      "# Tool",
      "",
      "[![badge](badge.svg)](https://ci.example.com) ![image][pic] ![logo]",
      '<p align="center"><img src="demo.gif" alt="demo"></p>',
      "<p>Real prose.</p>",
      "",
      "[pic]: image.png",
    ].join("\n");
    expect(Summarize.readmeText(readme)).toBe("# Tool\n\nReal prose.");
  });

  test("keeps type parameters in prose, inline code, and fenced code", () => {
    const readme =
      "Use `Vec<T>` or Vec<T> here.\n\n```rust\nlet v: Vec<String> = Vec::new(); // <b>\n```\n\nMore <b>text</b>.";
    expect(Summarize.readmeText(readme)).toBe(
      "Use `Vec<T>` or Vec<T> here.\n\n```rust\nlet v: Vec<String> = Vec::new(); // <b>\n```\n\nMore text.",
    );
    const generics = "Returns Option<A>, Box<I>, Array<S>, Map<U>, or Stream<A>.";
    expect(Summarize.readmeText(generics)).toBe(generics);
  });

  test("keeps the address of an email autolink", () => {
    expect(Summarize.readmeText("Contact <support@example.com> for help.")).toBe(
      "Contact support@example.com for help.",
    );
  });

  test("returns null for a README that is only images", () => {
    const readme =
      '<p align="center">\n  <picture><source srcset="dark.png"><img src="logo.png"></picture>\n</p>\n\n![shot](shot.png)\n';
    expect(Summarize.readmeText(readme)).toBeNull();
  });

  test("returns null for binary content and strips a few replacement characters from text", () => {
    expect(Summarize.readmeText("�PNG\u0000\u0000\u0000A")).toBeNull();
    expect(Summarize.readmeText("�(�A")).toBeNull();
    expect(Summarize.readmeText(`# Tool\n\n${"Real prose. ".repeat(20)}caf�`)).toBe(
      `# Tool\n\n${"Real prose. ".repeat(19)}Real prose. caf`,
    );
  });

  test("keeps text in any language", () => {
    expect(Summarize.readmeText("# 照片管理\n\n自托管的照片和视频管理工具。")).toBe(
      "# 照片管理\n\n自托管的照片和视频管理工具。",
    );
  });

  test("finishes adversarial READMEs of 300,000 characters in under a second each", () => {
    const size = 300_000;
    const inputs = ["normal prose ".repeat(25_000), "<a", "<!--", "![", "[](", "<p ", "```a\n", "`", "[x]: "].map(
      (unit) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size),
    );
    for (const input of inputs) {
      const started = performance.now();
      Summarize.readmeText(input);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });
});

describe("prompt", () => {
  test("cleans the README and renders none when nothing is left", () => {
    expect(Summarize.promptOf({ ...repo, readme: "![only](image.png)" }).text).toEndWith("README:\nnone");
    expect(Summarize.promptOf({ ...repo, readme: "<b>Bold</b> words" }).text).toEndWith("README:\nBold words");
  });

  test("carries as evidence the README text the prompt sent, and none when nothing is left", () => {
    expect(Summarize.promptOf({ ...repo, readme: "<b>Bold</b> words" }).input).toEqual({
      fullName: repo.fullName,
      description: "A Rust crate for cooking up terminal user interfaces",
      topics: repo.topics,
      readme: "Bold words",
    });
    expect(Summarize.promptOf({ ...repo, description: null, readme: "![only](image.png)" }).input).toMatchObject({
      description: "",
      readme: "",
    });
    const long = Summarize.promptOf({ ...repo, readme: "x".repeat(30_000) });
    expect(long.text).toEndWith(`README:\n${long.input.readme}`);
    expect(long.input.readme).toEndWith("\n[README truncated]");
  });
});
