import * as Embeddings from "@stargrep/ai/embeddings";
import * as Summarize from "@stargrep/ai/summarize";
import * as Share from "@stargrep/runtime/budget-share";
import { aiGatewayKey } from "@stargrep/runtime/config";
import { serverTokenKind } from "@stargrep/runtime/server-token";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import * as Layers from "../src/layers.ts";
import * as Secrets from "../src/secrets.ts";

const withEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

const app = {
  STARGREP_GITHUB_APP_PRIVATE_KEY: "key",
  STARGREP_GITHUB_APP_CLIENT_ID: "Iv23li",
  AI_GATEWAY_API_KEY: "key",
};
const pat = { STARGREP_GITHUB_TOKEN: "token", AI_GATEWAY_API_KEY: "key" };

describe("stage secrets", () => {
  it("treats an empty secret as missing", async () => {
    const read = await Effect.runPromise(
      Effect.all([Secrets.githubToken, aiGatewayKey]).pipe(
        withEnv({ STARGREP_GITHUB_TOKEN: "", AI_GATEWAY_API_KEY: "" }),
      ),
    );
    expect(read).toEqual([Option.none(), Option.none()]);
  });

  it("reads the server token kind as app or pat, and an unset or empty variable as pat", async () => {
    const kinds = await Promise.all(
      [
        {},
        { STARGREP_GITHUB_SERVER_TOKEN: "" },
        { STARGREP_GITHUB_SERVER_TOKEN: "app" },
        { STARGREP_GITHUB_SERVER_TOKEN: "pat" },
      ].map((env) => Effect.runPromise(Effect.all([serverTokenKind]).pipe(withEnv(env)))),
    );
    expect(kinds.flat()).toEqual(["pat", "pat", "app", "pat"]);
    const refused = await Effect.runPromiseExit(
      Effect.all([serverTokenKind]).pipe(withEnv({ STARGREP_GITHUB_SERVER_TOKEN: "apps" })),
    );
    expect(Exit.isFailure(refused)).toBe(true);
  });

  it("fails a prod deploy that lacks the credential its kind reads with, so prod can go back to the personal token", async () => {
    const outcomes = await Promise.all(
      [
        Secrets.requireStageSecrets("prod", "app").pipe(withEnv({})),
        Secrets.requireStageSecrets("prod", "app").pipe(withEnv(pat)),
        Secrets.requireStageSecrets("prod", "app").pipe(withEnv({ ...app, STARGREP_GITHUB_APP_CLIENT_ID: "" })),
        Secrets.requireStageSecrets("prod", "app").pipe(withEnv({ ...app, AI_GATEWAY_API_KEY: "" })),
        Secrets.requireStageSecrets("prod", "app").pipe(withEnv(app)),
        Secrets.requireStageSecrets("prod", "pat").pipe(withEnv(app)),
        Secrets.requireStageSecrets("prod", "pat").pipe(withEnv({ ...app, ...pat })),
      ].map((check) => Effect.runPromiseExit(check)),
    );
    expect(outcomes.map(Exit.isSuccess)).toEqual([false, false, false, false, true, false, true]);
  });

  it("fails any other stage that can read the App's key, and deploys one with a personal token or none", async () => {
    const outcomes = await Promise.all(
      [
        Secrets.requireStageSecrets("pr-18", "pat").pipe(withEnv({})),
        Secrets.requireStageSecrets("pr-18", "pat").pipe(withEnv(pat)),
        Secrets.requireStageSecrets("pr-18", "pat").pipe(withEnv(app)),
        Secrets.requireStageSecrets("dev_stefano", "pat").pipe(withEnv(app)),
      ].map((check) => Effect.runPromiseExit(check)),
    );
    expect(outcomes.map(Exit.isSuccess)).toEqual([true, true, false, false]);
    expect(String(outcomes[2])).toContain("belongs to prod only");
  });

  it("reads only the credential its kind uses", async () => {
    const read = (kind: "app" | "pat", env: Record<string, string>) =>
      Effect.runPromiseExit(
        Effect.all([Secrets.serverToken(kind)]).pipe(
          Effect.map(([token]) => token),
          withEnv(env),
        ),
      );
    const outcomes = await Promise.all([
      read("pat", {}),
      read("pat", { ...app, ...pat }),
      read("app", { ...app, ...pat }),
      read("app", pat),
    ]);
    expect(
      outcomes.map((exit) =>
        Exit.isSuccess(exit)
          ? Option.match(exit.value, { onNone: () => "none", onSome: (token) => token._tag })
          : "fails",
      ),
    ).toEqual(["none", "Pat", "App", "fails"]);
  });

  const share = (stage: string, kind: "app" | "pat", env: Record<string, string>) =>
    Effect.runPromiseExit(Share.stageBudgetShare(stage, kind).pipe(withEnv(env)));

  it("gives the App token 0.9 of its budget and a personal token 0.5, and lets a preview set a number in (0, 1]", async () => {
    const outcomes = await Promise.all([
      share("pr-18", "pat", {}),
      share("pr-18", "app", {}),
      share("pr-18", "pat", { GITHUB_BUDGET_SHARE: "0.02" }),
      share("pr-18", "pat", { GITHUB_BUDGET_SHARE: "1" }),
    ]);
    expect(outcomes).toEqual([Exit.succeed(0.5), Exit.succeed(0.9), Exit.succeed(0.02), Exit.succeed(1)]);
    const refused = await Promise.all(
      ["0", "-0.1", "1.5", "half", "NaN"].map((value) => share("pr-18", "pat", { GITHUB_BUDGET_SHARE: value })),
    );
    expect(refused.map(Exit.isFailure)).toEqual([true, true, true, true, true]);
  });

  it("fails a prod deploy with any share other than its token's", async () => {
    const outcomes = await Promise.all([
      share("prod", "app", {}),
      share("prod", "app", { GITHUB_BUDGET_SHARE: "0.9" }),
      share("prod", "app", { GITHUB_BUDGET_SHARE: "0.5" }),
      share("prod", "pat", {}),
      share("prod", "pat", { GITHUB_BUDGET_SHARE: "0.9" }),
    ]);
    expect(outcomes.map((exit) => (Exit.isSuccess(exit) ? exit.value : "fails"))).toEqual([
      0.9,
      0.9,
      "fails",
      0.5,
      "fails",
    ]);
    expect(String(outcomes[2])).toContain("prod takes a GitHub budget share of 0.9 with app");
  });

  it("fails every model call with AiKeyMissing when the AI Gateway key is empty", async () => {
    const errors = await Effect.runPromise(
      Effect.gen(function* () {
        const ai = yield* Layers.aiModels;
        return yield* Effect.gen(function* () {
          const embeddings = yield* Embeddings.Embeddings;
          const facts = { fullName: "owner/repo", description: null, topics: [], language: null, readme: null };
          return [
            (yield* Effect.flip(Summarize.summarize(facts)))._tag,
            (yield* Effect.flip(embeddings.embed(["x"])))._tag,
          ];
        }).pipe(Effect.provide(ai));
      }).pipe(withEnv({ AI_GATEWAY_API_KEY: "" })),
    );
    expect(errors).toEqual(["AiKeyMissing", "AiKeyMissing"]);
  });
});
