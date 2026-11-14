import { describe, expect, test } from "bun:test";
import * as Spelling from "./spelling.ts";

describe("Spelling", () => {
  test("counts a swap, a missing letter, an extra letter, and a wrong letter as one edit", () => {
    expect(
      [
        ["tetirgo", "tetrigo"],
        ["pacsek", "pacseek"],
        ["hammmox", "hammox"],
        ["zigloa", "ziglua"],
      ].map(([from = "", to = ""]) => Spelling.edits(from, to)),
    ).toEqual([1, 1, 1, 1]);
  });

  test("counts no further than two edits", () => {
    expect([Spelling.edits("ripgrep", "ripgrep"), Spelling.edits("ab", "ba"), Spelling.edits("hlargs", "zzz")]).toEqual(
      [0, 1, 2],
    );
  });

  test("runs letters and digits together in lower case", () => {
    expect(["habbit trove", "hlargs.nvim", "Code-Minimap", "トリポロ"].map(Spelling.letters)).toEqual([
      "habbittrove",
      "hlargsnvim",
      "codeminimap",
      "",
    ]);
  });
});
