import { describe, expect, test } from "bun:test";
import { pickReadme, type TreeEntry } from "./readme.ts";

const entry = (name: string, type = "blob") =>
  ({ name, type, oid: name.length.toString(16).padStart(40, "0") }) as TreeEntry;

describe("pickReadme", () => {
  test("prefers Markdown over other README files", () => {
    expect(pickReadme([entry("README"), entry("README.rst"), entry("readme.md")])?.name).toBe("readme.md");
  });

  test("ignores directories and files that only start with README", () => {
    expect(pickReadme([entry("readme", "tree"), entry("README-dev.md"), entry("readme.txt")])?.name).toBe("readme.txt");
  });

  test("returns null without a README", () => {
    expect(pickReadme([entry("LICENSE"), entry("src", "tree")])).toBeNull();
  });
});
