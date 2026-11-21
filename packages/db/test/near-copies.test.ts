import { describe, expect, test } from "bun:test";
import { copyDistance, type Neighbor, suspects, withoutCopies } from "../src/queries/near-copies.ts";

let lastId = 0;
const repo = (fullName: string, stars: number | null, distance = 0.1): Neighbor => {
  const [owner = "", name = ""] = fullName.split("/");
  lastId += 1;
  return { repo: { id: lastId, owner, name }, stars, distance };
};
const named = (a: string, b: string) => copyDistance(repo(a, 1).repo, repo(b, 1).repo);
const names = (found: ReadonlyArray<Neighbor>) => found.map(({ repo }) => `${repo.owner}/${repo.name}`);

describe("copyDistance", () => {
  test("counts a fork that keeps the name, adds a locale or a few letters, or leaves a word out", () => {
    expect(named("kjj6198/build-your-own-x", "codecrafters-io/build-your-own-x")).toBe(0.15);
    expect(named("XiaomingX/build-your-own-xxx", "codecrafters-io/build-your-own-x")).toBe(0.15);
    expect(named("Teslow/build-your-x", "codecrafters-io/build-your-own-x")).toBe(0.15);
    expect(named("kevingo/system-design-primer-zh-tw", "donnemartin/system-design-primer")).toBe(0.15);
    expect(named("aluismoya/EbookFoundation-free-programming-books", "EbookFoundation/free-programming-books")).toBe(
      0.15,
    );
    expect(
      named(
        "jderazoa/https-github.com-practical-tutorials-project-based-learning",
        "practical-tutorials/project-based-learning",
      ),
    ).toBe(0.15);
  });

  test("asks a short name to sit nearer, since distinct repos share it", () => {
    expect(named("teris-io/cli", "urfave/cli")).toBe(0.1);
    expect(named("HaidyCao/frp", "fatedier/frp")).toBe(0.1);
  });

  test("leaves out siblings, ports, companions, and names that only share a concept", () => {
    expect(named("microsoft/playwright-java", "microsoft/playwright")).toBe(0);
    expect(named("antimatter15/tesseract-rs", "tesseract-ocr/tesseract")).toBe(0);
    expect(named("abetlen/llama-cpp-python", "ggml-org/llama.cpp")).toBe(0);
    expect(named("Graph-COM/SubgraphRAG", "microsoft/graphrag")).toBe(0);
    expect(named("cweagans/awesome-diy-software", "codecrafters-io/build-your-own-x")).toBe(0);
  });
});

describe("withoutCopies", () => {
  test("keeps 5 different repos out of a neighborhood full of copies", () => {
    const opened = repo("codecrafters-io/build-your-own-x", 561_821, 0);
    // Named alike, but farther from the opened repo and the others than a copy sits.
    const far = repo("far/build-your-own-x", 50, 0.3);
    const found = [
      repo("someone/tutorials", 100, 0.03),
      repo("kjj6198/build-your-own-x", 489, 0.103),
      repo("Teslow/build-your-x", 636, 0.121),
      repo("XiaomingX/build-your-own-xxx", 324, 0.134),
      repo("jderazoa/https-github.com-practical-tutorials-project-based-learning", 432, 0.148),
      repo("cweagans/awesome-diy-software", 783, 0.151),
      repo("AlgoryL/Projects-from-Scratch", 1959, 0.156),
      repo("practical-tutorials/project-based-learning", 289_574, 0.18),
      // A tenth of the stars or more: a project in its own right.
      repo("big/build-your-own-x", 60_000, 0.19),
      far,
    ];
    // The fake database puts every suspect 0.06 from its original, but the far one 0.25 from every other.
    const apart = suspects(found, []).map((pair) => ({ ...pair, distance: pair.copy === far.repo.id ? 0.25 : 0.06 }));

    expect(names(withoutCopies(opened, found, apart, 5))).toEqual([
      "cweagans/awesome-diy-software",
      "AlgoryL/Projects-from-Scratch",
      "practical-tutorials/project-based-learning",
      "big/build-your-own-x",
      "far/build-your-own-x",
    ]);
  });

  test("leaves out a fork of a reference, and keeps a suspect that sits far from its original", () => {
    const opened = repo("someone/learn-things", 300, 0);
    const starred = repo("teacher/learn-x", 5000, 0.12);
    const fork = repo("student/learn-x", 20, 0.13);
    const namesake = repo("other/curriculum", 600, 0.14);
    const famous = repo("TheOdinProject/curriculum", 13_000, 0.2);
    const found = [fork, namesake, famous];
    const pairs = suspects(found, [starred]);

    expect(pairs.map((pair) => [pair.copy, pair.original, pair.within])).toEqual([
      [fork.repo.id, starred.repo.id, 0.1],
      [namesake.repo.id, famous.repo.id, 0.15],
    ]);
    const apart = pairs.map((pair) => ({ ...pair, distance: pair.copy === fork.repo.id ? 0.02 : 0.17 }));
    expect(names(withoutCopies(opened, found, apart, 5))).toEqual(["other/curriculum", "TheOdinProject/curriculum"]);
  });

  test("never counts a repo without a star count as a copy", () => {
    const opened = repo("codecrafters-io/build-your-own-x", null, 0);
    const found = [repo("kjj6198/build-your-own-x", 489, 0.01)];

    expect(withoutCopies(opened, found, [], 5)).toEqual(found);
  });
});
