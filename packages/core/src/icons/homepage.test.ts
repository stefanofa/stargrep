import { describe, expect, test } from "bun:test";
import { iconUrls } from "./homepage.ts";

describe("iconUrls", () => {
  test("ranks the apple-touch icon, then large rasters, then SVG, then small rasters, and ends with /favicon.ico", () => {
    const html = `<!doctype html><html><head>
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32">
      <link rel="apple-touch-icon" href="https://cdn.example.com/touch.png">
      <link rel="mask-icon" href="/pinned.svg" color="#000">
      <link rel=icon href=/icon.svg>
      <link rel="icon" href="/icon-192.png" sizes="192x192">
      <link rel="stylesheet" href="/site.css">
    </head><body><link rel="icon" href="/late.png"></body></html>`;
    expect(iconUrls(html, "https://kit.dev/docs/")).toEqual([
      "https://cdn.example.com/touch.png",
      "https://kit.dev/icon-192.png",
      "https://kit.dev/icon.svg",
      "https://kit.dev/favicon-32.png",
    ]);
  });

  test("tries agent-device.dev's apple-touch icon before the SVG favicon that draws its letter as text", () => {
    const html = `<head>
      <link rel="icon" href="/favicon.svg" type="image/svg+xml">
      <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    </head>`;
    expect(iconUrls(html, "https://agent-device.dev/")).toEqual([
      "https://agent-device.dev/apple-touch-icon.png",
      "https://agent-device.dev/favicon.svg",
      "https://agent-device.dev/favicon-32.png",
      "https://agent-device.dev/favicon.ico",
    ]);
  });

  test("ranks an apple-touch icon with no sizes after the ones that declare a size", () => {
    const html = `<link rel="apple-touch-icon" href="/apple-57.png">
      <link rel="apple-touch-icon" sizes="60x60" href="/apple-60.png">
      <link rel="apple-touch-icon" sizes="180x180" href="/apple-180.png">`;
    expect(iconUrls(html, "https://www.passportjs.org/")[0]).toBe("https://www.passportjs.org/apple-180.png");
  });

  test("does not take sizes=any on a raster as large", () => {
    const html = `<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" href="/favicon.svg" type="image/svg+xml">`;
    expect(iconUrls(html, "https://www.aihero.dev/")).toEqual([
      "https://www.aihero.dev/favicon.svg",
      "https://www.aihero.dev/favicon.ico",
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
