import { describe, expect, test } from "bun:test";
import { readmeText } from "./readme-text.ts";

describe("readmeText", () => {
  test("drops badges, images, and comments but keeps the words", () => {
    const readme = [
      "<!-- generated -->",
      "# Ratatui",
      "",
      "[![Crate](https://img.shields.io/crates/v/ratatui)](https://crates.io/crates/ratatui) ![CI][ci-badge]",
      "",
      "Ratatui builds <b>terminal user interfaces</b>.",
      "",
      '<p align="center"><img src="demo.gif" alt="demo"></p>',
      "",
      "[ci-badge]: https://github.com/ratatui/ratatui/actions/badge.svg",
    ].join("\n");
    expect(readmeText(readme)).toBe("# Ratatui\n\nRatatui builds terminal user interfaces.");
  });

  test("returns null for a README that is only images", () => {
    const readme =
      '<p align="center">\n  <picture><source srcset="dark.png"><img src="logo.png"></picture>\n</p>\n\n![screenshot](shot.png)\n';
    expect(readmeText(readme)).toBeNull();
  });

  test("keeps text in any language", () => {
    expect(readmeText("# 照片管理\n\n自托管的照片和视频管理工具。")).toBe("# 照片管理\n\n自托管的照片和视频管理工具。");
  });
});
