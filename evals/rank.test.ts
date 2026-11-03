import { describe, expect, test } from "bun:test";
import { type Row, rankEmbeddings, rankSummaries } from "./rank.ts";

const row = (
  model: string,
  recall: number,
  medianMillis: number,
  cost = 0,
  stage: Row["stage"] = "embedding",
): Row => ({
  stage,
  model,
  recall,
  medianMillis,
  cost,
  failures: 0,
});

const run2 = [
  row("openai/text-embedding-3-small", 0.968, 537),
  row("openai/text-embedding-3-large", 0.969, 536),
  row("google/gemini-embedding-001", 0.99, 954),
  row("voyage/voyage-4-lite", 0.983, 465),
  row("voyage/voyage-4", 0.986, 379),
  row("cohere/embed-v5.0-fast", 0.981, 324),
  row("alibaba/qwen3-embedding-8b", 0.965, 399),
];

const run3 = [
  row("openai/text-embedding-3-small", 0.959, 500),
  row("openai/text-embedding-3-large", 0.975, 503),
  row("google/gemini-embedding-001", 0.99, 969),
  row("voyage/voyage-4-lite", 0.979, 382),
  row("voyage/voyage-4", 0.988, 352),
  row("cohere/embed-v5.0-fast", 0.977, 291),
  row("alibaba/qwen3-embedding-8b", 0.965, 3608),
];

describe("rankEmbeddings", () => {
  test("orders models by recall, not by latency", () => {
    const { ranked } = rankEmbeddings([row("best", 0.6, 500), row("second", 0.5, 450), row("bad-fast", 0.1, 1)]);
    expect(ranked.map((entry) => entry.model)).toEqual(["best", "second", "bad-fast"]);
  });

  test("drops models over the latency budget before ranking", () => {
    const { ranked, overBudget } = rankEmbeddings([row("accurate-slow", 0.99, 969), row("fast", 0.98, 352)]);
    expect(ranked.map((entry) => entry.model)).toEqual(["fast"]);
    expect(overBudget.map((entry) => entry.model)).toEqual(["accurate-slow"]);
  });

  test("ranks voyage-4 then voyage-4-lite first on both recorded gateway runs", () => {
    for (const rows of [run2, run3]) {
      expect(
        rankEmbeddings(rows)
          .ranked.slice(0, 2)
          .map((entry) => entry.model),
      ).toEqual(["voyage/voyage-4", "voyage/voyage-4-lite"]);
    }
  });
});

describe("rankSummaries", () => {
  test("breaks a tie within one query by cost", () => {
    const ranked = rankSummaries([row("best", 1, 0, 9, "summary"), row("cheap", 0.995, 0, 1, "summary")], 129);
    expect(ranked.map((entry) => entry.model)).toEqual(["cheap", "best"]);
  });

  test("orders models outside the tie by recall", () => {
    const ranked = rankSummaries(
      [row("best", 1, 0, 9, "summary"), row("second", 0.95, 0, 5, "summary"), row("free", 0.1, 0, 0, "summary")],
      129,
    );
    expect(ranked.map((entry) => entry.model)).toEqual(["best", "second", "free"]);
  });
});
