import { expect } from "bun:test";
import { BudgetShare } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { optionalSecret, requiredSecret } from "./config.ts";
import { budgetShare, serverTokenPolicy } from "./server-token.ts";

it.effect("required and optional secrets agree on missing, empty, and populated values", () =>
  Effect.gen(function* () {
    for (const env of [{}, { KEY: "" }, { KEY: "value" }]) {
      const provider = ConfigProvider.fromUnknown(env);
      const optional = yield* optionalSecret("KEY").parse(provider);
      const required = yield* Effect.result(requiredSecret("KEY").parse(provider));
      expect(Option.map(optional, Redacted.value)).toEqual(env.KEY ? Option.some("value") : Option.none());
      expect(required._tag).toBe(env.KEY ? "Success" : "Failure");
    }
  }),
);

it.effect("direct deploys and workflows default prod to the App and every other stage to the PAT", () =>
  Effect.gen(function* () {
    for (const env of [{}, { STARGREP_GITHUB_SERVER_TOKEN: "" }]) {
      const provider = ConfigProvider.fromUnknown(env);
      expect(yield* serverTokenPolicy("prod").parse(provider)).toEqual({ kind: "app", share: BudgetShare.make(0.9) });
      for (const stage of ["pr-1", "dev_stefano", "shared"])
        expect(yield* serverTokenPolicy(stage).parse(provider)).toEqual({ kind: "pat", share: BudgetShare.make(0.5) });
    }
    expect(yield* budgetShare.parse(ConfigProvider.fromUnknown({ STARGREP_GITHUB_SERVER_TOKEN: "app" }))).toBe(
      BudgetShare.make(0.9),
    );
  }),
);
