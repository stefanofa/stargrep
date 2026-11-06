import * as Cloudflare from "@alchemy.run/cloudflare";
import * as FallbackGate from "@stargrep/github/fallback-gate";
import type { BudgetShare } from "@stargrep/github/schemas";
import * as TokenBudget from "@stargrep/github/token-budget";
import * as TokenGate from "@stargrep/github/token-gate";
import { budgetShare } from "@stargrep/runtime/budget-share";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
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

// Both objects send one request at a time within a share of their token's windows, and keep the windows in storage, so
// a restart keeps them.
const persistedGate = Effect.fn("GitHubGate.persisted")(function* (
  state: Cloudflare.DurableObjectState["Service"],
  share: BudgetShare,
) {
  const windows = TokenBudget.decodeWindows(yield* state.storage.get(windowsKey));
  const gate = yield* TokenGate.makeMemory({ share, windows: Option.getOrUndefined(windows) }).pipe(
    Effect.provide(FetchHttpClient.layer),
  );
  const persist = Effect.flatMap(gate.budget, (budget) => state.storage.put(windowsKey, budget.windows));
  return (token: Redacted.Redacted<string>) => {
    const serve = TokenGate.serve(TokenGate.TokenGate.of({ execute: gate.execute(token) }));
    return (request: TokenGate.RemoteRequest) => serve(request).pipe(Effect.tap(() => persist));
  };
});

export class GitHubGate extends Cloudflare.DurableObject<GitHubGate>()(
  "GitHubGate",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const serveWith = yield* persistedGate(state, yield* Effect.orDie(budgetShare));
      return { execute: serveWith(yield* requiredToken) };
    });
  }),
) {}

// One object per signed-in user, named by their user ID, because GitHub counts all of a user's tokens against one
// budget. The token comes with each call and is never stored.
export class UserGitHubGate extends Cloudflare.DurableObject<UserGitHubGate>()(
  "UserGitHubGate",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const serveWith = yield* persistedGate(state, FallbackGate.userShare);
      return {
        execute: (request: TokenGate.RemoteRequest, token: string) => serveWith(Redacted.make(token))(request),
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
