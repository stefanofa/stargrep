import * as Cloudflare from "@alchemy.run/cloudflare";
import * as TokenBudget from "@stargrep/github/token-budget";
import * as TokenGate from "@stargrep/github/token-gate";
import { budgetShare } from "@stargrep/runtime/budget-share";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { inRuntime } from "./layers.ts";
import { githubToken } from "./secrets.ts";

const windowsKey = "windows";

const requiredToken = Effect.flatMap(
  Effect.orDie(githubToken),
  Option.match({
    onNone: () => Effect.die("GitHubGate is bound only when STARGREP_GITHUB_TOKEN is set"),
    onSome: Effect.succeed,
  }),
);

export class GitHubGate extends Cloudflare.DurableObject<GitHubGate>()(
  "GitHubGate",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const windows = TokenBudget.decodeWindows(yield* state.storage.get(windowsKey));
      const gate = yield* TokenGate.makeMemory({
        token: yield* requiredToken,
        share: yield* Effect.orDie(budgetShare),
        windows: Option.getOrUndefined(windows),
      }).pipe(Effect.provide(FetchHttpClient.layer));
      const serve = TokenGate.serve(gate);
      return {
        execute: (request: TokenGate.RemoteRequest) =>
          serve(request).pipe(
            Effect.tap(() => Effect.flatMap(gate.budget, (budget) => state.storage.put(windowsKey, budget.windows))),
          ),
      };
    });
  }),
) {}

const layerRemote = (gates: Effect.Success<typeof GitHubGate>) =>
  Layer.unwrap(
    Effect.map(inRuntime, (run) =>
      TokenGate.layerRemote({ execute: (request) => run(gates.getByName("github-token").execute(request)) }),
    ),
  );

export const tokenGate = Effect.gen(function* (): Effect.fn.Return<
  Layer.Layer<TokenGate.TokenGate, never, RuntimeContext>,
  never,
  Effect.Services<typeof GitHubGate>
> {
  if (Option.isNone(yield* Effect.orDie(githubToken))) return TokenGate.layerMissing;
  return layerRemote(yield* GitHubGate);
});
