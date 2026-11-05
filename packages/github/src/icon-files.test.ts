import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { rankIconFiles } from "./icon-files.ts";
import { TreeEntry } from "./readme.ts";

const blob = (name: string, type = "blob") =>
  Schema.decodeSync(TreeEntry)({ name, type, oid: (name.length % 10).toString().repeat(40) });

const names = (entries: ReadonlyArray<string>, repo = "drawesome") =>
  rankIconFiles(
    entries.map((name) => blob(name)),
    repo,
  ).map((file) => file.name);

describe("rankIconFiles", () => {
  test("finds the root logo in antirez/ds4's tree among its source files", () => {
    expect(names(["LICENSE", "README.md", "logo.svg", "ds4.c", "speed-bench"], "ds4")).toEqual(["logo.svg"]);
  });

  test("puts a plain logo ahead of its theme variant, as in benjitaylor/drawesome", () => {
    expect(names(["logo-dark.svg", "logo.svg", "package.json"])).toEqual(["logo.svg", "logo-dark.svg"]);
  });

  test("ranks logo and icon over a repo-named file, then mark, then favicon, and SVG over PNG over ICO", () => {
    expect(
      names(["favicon.svg", "drawesome.png", "Logo.png", "icon.ico", "mark.svg", "logo.svg", "brand_white.webp"]),
    ).toEqual(["logo.svg", "Logo.png", "icon.ico", "drawesome.png", "mark.svg", "brand_white.webp", "favicon.svg"]);
  });

  test("ignores directories, other image names, and formats it cannot use", () => {
    expect(
      rankIconFiles(
        [blob("logo.svg", "tree"), blob("screenshot.png"), blob("logo.gif"), blob("logo.jpg"), blob("logos.svg")],
        "drawesome",
      ),
    ).toEqual([]);
  });
});
