import { describe, expect, test } from "bun:test";
import { redirectAllowed } from "./auth.ts";

const previewHost = /^stargrep-web-pr-\d+-[a-z0-9]+\.rewebdotso\.workers\.dev$/;

const prod = "https://stargrep.com";

describe("redirectAllowed", () => {
  test("allows the stage's own origin and a preview Worker of this account", () => {
    expect(redirectAllowed("/search", prod, previewHost)).toBe(true);
    expect(redirectAllowed("https://stargrep.com/?error=access_denied", prod, previewHost)).toBe(true);
    expect(
      redirectAllowed(
        "https://stargrep-web-pr-29-zskfnuav44lnwawz.rewebdotso.workers.dev/auth/callback/github/oauth-proxy?profile=x",
        prod,
        previewHost,
      ),
    ).toBe(true);
  });

  test("refuses any other host, scheme, or port", () => {
    for (const location of [
      "https://attacker.example/auth/callback/github/oauth-proxy",
      "https://stargrep-web-pr-29-abc.rewebdotso.workers.dev.attacker.example/",
      "https://stargrep-web-pr-29-abc.attacker.workers.dev/",
      "https://x-stargrep-web-pr-29-abc.rewebdotso.workers.dev/",
      "https://stargrep-web-prod-abc.rewebdotso.workers.dev/",
      "http://stargrep-web-pr-29-abc.rewebdotso.workers.dev/",
      "https://stargrep-web-pr-29-abc.rewebdotso.workers.dev:8443/",
      "//attacker.example/",
    ]) {
      expect([location, redirectAllowed(location, prod, previewHost)]).toEqual([location, false]);
    }
  });
});
