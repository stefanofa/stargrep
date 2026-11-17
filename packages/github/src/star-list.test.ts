import { describe, expect, test } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { decodeStarItems, nextPage, toStar } from "./star-list.ts";

const link = (target: string, rel = "next") => `<${target}>; rel="${rel}"`;

it.effect("decodes star pages owned by existing GitHub accounts outside the signup syntax", () =>
  Effect.gen(function* () {
    for (const owner of ["Nek-", "john--", "foo--bar", "managed_user"]) {
      const page = yield* decodeStarItems(
        JSON.stringify([
          {
            starred_at: "2026-11-01T00:00:00Z",
            repo: { id: 42, node_id: "R_42", name: "repo", full_name: `${owner}/repo`, owner: { login: owner } },
          },
        ]),
      );
      expect(page.map(toStar)).toMatchObject([{ repo: { owner } }]);
    }
  }),
);

it.effect("keeps the metadata a star page carries, and decodes a page without it", () =>
  Effect.gen(function* () {
    const page = yield* decodeStarItems(
      JSON.stringify([
        {
          starred_at: "2026-11-01T00:00:00Z",
          repo: {
            id: 42,
            node_id: "R_42",
            name: "fzf",
            full_name: "junegunn/fzf",
            owner: { login: "junegunn" },
            description: "A command-line fuzzy finder",
            topics: ["cli", "fzf"],
            language: "Go",
            stargazers_count: 79000,
          },
        },
        {
          starred_at: "2026-11-01T00:00:00Z",
          repo: { id: 43, node_id: "R_43", name: "bare", full_name: "x/bare", owner: { login: "x" } },
        },
      ]),
    );
    expect(page.map((item) => toStar(item).repo)).toMatchObject([
      { description: "A command-line fuzzy finder", topics: ["cli", "fzf"], language: "Go", stars: 79000 },
      { description: null, topics: [], language: null, stars: null },
    ]);
  }),
);

it.effect("keeps a star whose owner GitHub hides, reading the owner from full_name", () =>
  Effect.gen(function* () {
    const page = yield* decodeStarItems(
      JSON.stringify([
        {
          starred_at: "2020-05-24T06:03:10Z",
          repo: {
            id: 245356768,
            node_id: "MDEwOlJlcG9zaXRvcnkyNDUzNTY3Njg=",
            name: "forkbacon",
            full_name: "bejoistic/forkbacon",
            owner: null,
            description: "Simple GitHub Action to automatically update fork",
            topics: [],
            language: "Makefile",
            stargazers_count: 23,
          },
        },
      ]),
    );
    expect(page.map((item) => toStar(item).repo)).toMatchObject([
      {
        id: 245356768,
        nodeId: "MDEwOlJlcG9zaXRvcnkyNDUzNTY3Njg=",
        owner: "bejoistic",
        name: "forkbacon",
        description: "Simple GitHub Action to automatically update fork",
        topics: [],
        language: "Makefile",
        stars: 23,
      },
    ]);
  }),
);

describe("nextPage", () => {
  test("reads the page number of the next link", () => {
    const header = `${link("https://api.github.com/user/1/starred?page=1", "prev")}, ${link("https://api.github.com/user/1/starred?per_page=100&page=3")}`;
    expect(nextPage(header)).toEqual(Result.succeed(Option.some(3)));
  });

  test("returns null without a header or a next link", () => {
    expect(nextPage(undefined)).toEqual(Result.succeed(Option.none()));
    expect(nextPage(link("https://api.github.com/user/1/starred?page=1", "prev"))).toEqual(
      Result.succeed(Option.none()),
    );
  });

  test("fails on a next link it cannot read", () => {
    expect(nextPage(link("not a url"))).toEqual(Result.fail("invalid-link"));
    expect(nextPage(link("https://api.github.com/user/1/starred?page=abc"))).toEqual(Result.fail("invalid-link"));
    expect(nextPage(link("https://api.github.com/user/1/starred"))).toEqual(Result.fail("invalid-link"));
  });
});
