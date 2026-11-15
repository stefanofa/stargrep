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
    defaultAiProvider: "gateway",
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

test("previews default to the stand-in models, and local stages and prod to the gateway", () => {
  expect(["pr-1", "dev_stefano", "prod"].map((stage) => stageSettings(stage).defaultAiProvider)).toEqual([
    "fake",
    "gateway",
    "gateway",
  ]);
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
  expect(allowed("https://pr-1.stargrep.com/auth/callback/github/oauth-proxy")).toBe(true);
  for (const location of [
    "https://www.stargrep.com/",
    "https://pr-1-debug.stargrep.com/",
    "https://pr-1.attacker.example/",
    "https://pr-1.stargrep.com.attacker.example/",
    "http://pr-1.stargrep.com/",
    "https://pr-1.stargrep.com:8443/",
  ])
    expect(allowed(location)).toBe(false);
});
