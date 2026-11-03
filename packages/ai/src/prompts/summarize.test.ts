import { describe, expect } from "bun:test";
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
