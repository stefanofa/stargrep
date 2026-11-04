import { describe, expect, test } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Fake from "../fake.ts";
import * as SummarizeFake from "./summarize.fake.ts";
import * as Summarize from "./summarize.ts";

const repo: Summarize.RepoFacts = {
  fullName: "ratatui/ratatui",
  description: "A Rust crate for cooking up terminal user interfaces",
  topics: ["rust", "tui"],
  language: "Rust",
  readme: "# Ratatui\n\nRatatui builds rich terminal user interfaces and dashboards.",
};

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
    expect(Summarize.prompt({ ...repo, readme: "![only](image.png)" })).toEndWith("README:\nnone");
    expect(Summarize.prompt({ ...repo, readme: "<b>Bold</b> words" })).toEndWith("README:\nBold words");
  });
});
