import { expect, test } from "bun:test";
import { redirectAllowed } from "@stargrep/auth/auth";
import { authConfig, names } from "@stargrep/auth/config";
import { stageSettings } from "@stargrep/runtime/stage";
import { previewHostBinding, settings } from "@stargrep/worker/stage";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { inStage } from "./test-stage.ts";

test("production retains its database, region, placement, and resource lifetime policies", () => {
  expect(inStage("prod")(settings)).toEqual({
    stage: "prod",
    production: true,
    defaultServerToken: "app",
    database: {
      logicalId: "ProjectUsEast",
      name: "stargrep-us-east",
      region: "aws-us-east-1",
      pgVersion: 17,
      historyRetentionSeconds: 21600,
      expiryDays: undefined,
    },
    placement: { region: "aws:us-east-1" },
    retain: true,
    debug: false,
  });
});

test("preview and local stages use the preview project and disposable resources", () => {
  for (const stage of ["pr-1", "dev_stefano"])
    expect(stageSettings(stage)).toMatchObject({
      production: false,
      defaultServerToken: "pat",
      retain: false,
      debug: true,
      database: {
        logicalId: "ProjectPreviewsUsEast",
        name: "stargrep-previews-us-east",
        region: "aws-us-east-1",
        historyRetentionSeconds: 0,
        expiryDays: 14,
      },
      placement: { region: "aws:us-east-1" },
    });
});

test("the deploy's preview-host allowlist survives the auth config binding", async () => {
  const config = Option.getOrThrow(
    await Effect.runPromise(
      authConfig.parse(
        ConfigProvider.fromUnknown({
          ...previewHostBinding,
          [names.clientId]: "test-id",
          [names.clientSecret]: "test-secret",
          [names.secret]: "test-auth-secret",
        }),
      ),
    ),
  );
  const allowed = (location: string) => redirectAllowed(location, "https://stargrep.com", config.previewHost);
  expect(allowed("https://stargrep-web-pr-1-abc.rewebdotso.workers.dev/auth/callback/github/oauth-proxy")).toBe(true);
  for (const location of [
    "https://stargrep-web-prod-abc.rewebdotso.workers.dev/",
    "https://stargrep-web-pr-1-abc.attacker.workers.dev/",
    "https://stargrep-web-pr-1-abc.rewebdotso.workers.dev.attacker.example/",
    "http://stargrep-web-pr-1-abc.rewebdotso.workers.dev/",
    "https://stargrep-web-pr-1-abc.rewebdotso.workers.dev:8443/",
  ])
    expect(allowed(location)).toBe(false);
});
