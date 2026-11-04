import * as Cloudflare from "@alchemy.run/cloudflare";
import { BudgetShare } from "@stargrep/github/schemas";
import type * as TokenBudget from "@stargrep/github/token-budget";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";

export const githubToken = Config.Redacted("STARGREP_GITHUB_TOKEN");

// The token belongs to the person who runs the stage, so half of each hourly window stays theirs.
const share = BudgetShare.make(0.5);

const budgetKey = "budget";

export class GitHubGate extends Cloudflare.DurableObject<GitHubGate>()(
  "GitHubGate",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const token = yield* Effect.orDie(githubToken);
      const budget = yield* state.storage.get<TokenBudget.Budget>(budgetKey);
      const services = yield* Layer.build(
        TokenGate.layerMemory({ token, share, budget }).pipe(Layer.provide(FetchHttpClient.layer)),
      );
      const gate = Context.get(services, TokenGate.TokenGate);
      const serve = TokenGate.serve(gate);
      return {
        execute: (request: TokenGate.RemoteRequest) =>
          serve(request).pipe(
            Effect.tap(() => Effect.flatMap(gate.budget, (spent) => state.storage.put(budgetKey, spent))),
          ),
        budget: () => gate.budget,
      };
    });
  }),
) {}
