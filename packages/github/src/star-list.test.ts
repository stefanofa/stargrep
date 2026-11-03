import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { nextPage } from "./star-list.ts";

const link = (target: string, rel = "next") => `<${target}>; rel="${rel}"`;

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
