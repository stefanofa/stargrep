import { describe, expect, test } from "bun:test";
import { iconUrls } from "./homepage.ts";

describe("iconUrls", () => {
  test("ranks SVG, then the apple-touch icon, then the largest size, and ends with /favicon.ico", () => {
    const html = `<!doctype html><html><head>
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32">
      <link rel="apple-touch-icon" href="https://cdn.example.com/touch.png">
      <link rel="mask-icon" href="/pinned.svg" color="#000">
      <link rel=icon href=/icon.svg>
      <link rel="stylesheet" href="/site.css">
    </head><body><link rel="icon" href="/late.png"></body></html>`;
    expect(iconUrls(html, "https://kit.dev/docs/")).toEqual([
      "https://kit.dev/icon.svg",
      "https://cdn.example.com/touch.png",
      "https://kit.dev/favicon-32.png",
      "https://kit.dev/favicon-16.png",
    ]);
  });

  test("resolves relative hrefs against the page and skips data URLs", () => {
    expect(
      iconUrls(
        `<link rel="shortcut icon" href="data:image/png;base64,AAAA"><link rel="icon" href="img/logo.svg">`,
        "https://acme.github.io/kit/",
      ),
    ).toEqual(["https://acme.github.io/kit/img/logo.svg", "https://acme.github.io/favicon.ico"]);
  });

  test("falls back to /favicon.ico for a page with no icon links or no page at all", () => {
    expect(iconUrls("", "https://kit.dev/")).toEqual(["https://kit.dev/favicon.ico"]);
  });
});
