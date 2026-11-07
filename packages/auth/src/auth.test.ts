import { describe, expect, test } from "bun:test";
import { UserId } from "@stargrep/db/auth-schema";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { readGitHubTokenWithin, redirectAllowed } from "./auth.ts";

const previewHost = /^stargrep-web-pr-\d+-[a-z0-9]+\.rewebdotso\.workers\.dev$/;

const prod = "https://stargrep.com";

it.effect("bounds a stalled web token refresh to ten seconds", () =>
  Effect.gen(function* () {
    const createdAt = DateTime.toDateUtc(DateTime.makeUnsafe(0));
    const stalled = {
      $context: Promise.resolve({
        internalAdapter: {
          findAccounts: async () => [
            {
              id: "account-1",
              providerId: "github",
              accountId: "1",
              userId: "user-1",
              createdAt,
              updatedAt: createdAt,
            },
          ],
        },
      }),
      api: { getAccessToken: () => new Promise<never>(() => {}) },
    };
    const fiber = yield* Effect.forkChild(Effect.flip(readGitHubTokenWithin(stalled, UserId.make("user-1"))));
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "AuthFailed", operation: "token" });
  }),
);

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
