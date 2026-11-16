import { describe, expect, test } from "bun:test";
import { scrub, sends } from "../src/lib/analytics.ts";

describe("browser analytics", () => {
  test("loads only on prod's own host, never on a preview, localhost, or a test page", () => {
    expect(sends("stargrep.com")).toBe(true);
    for (const hostname of ["pr-128.stargrep.com", "pr-128-debug.stargrep.com", "localhost", "127.0.0.1", ""]) {
      expect(sends(hostname)).toBe(false);
    }
  });

  test("sends every URL without its query string or fragment, the search's words included", () => {
    const scrubbed = scrub({
      uuid: "e1",
      event: "$pageview",
      properties: {
        $current_url: "https://stargrep.com/ada?q=private+words&lang=rust#repo",
        $pathname: "/ada",
        $referrer: "https://www.google.com/search?q=stargrep",
        $exception_list: [{ value: "Failed to load https://stargrep.com/ada?q=private+words" }],
        utm_source: "newsletter",
      },
      $set_once: { $initial_current_url: "https://stargrep.com/?q=private+words" },
    });
    expect(scrubbed.properties).toEqual({
      $current_url: "https://stargrep.com/ada",
      $pathname: "/ada",
      $referrer: "https://www.google.com/search",
      $exception_list: [{ value: "Failed to load https://stargrep.com/ada" }],
      utm_source: "newsletter",
    });
    expect(scrubbed.$set_once).toEqual({ $initial_current_url: "https://stargrep.com/" });
    expect(JSON.stringify(scrubbed)).not.toContain("private");
  });
});
