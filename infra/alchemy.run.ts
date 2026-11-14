// @effect-diagnostics layerMergeAllWithDependencies:off - the stack supplies HttpClient to every provider layer.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Neon from "@alchemy.run/neon";
import { aiProvider } from "@stargrep/runtime/ai-key";
import { stackName } from "@stargrep/runtime/stage";
import { Website } from "@stargrep/web/website";
import { ZoneRateLimit } from "@stargrep/web/zone-rate-limit";
import Worker from "@stargrep/worker";
import DebugWorker, { DebugToken } from "@stargrep/worker/debug";
import { settings, withStageConfig } from "@stargrep/worker/stage";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { state } from "./state.ts";

export const app = Effect.gen(function* () {
  const { stage, production, debug: hasDebug } = yield* settings;
  const worker = yield* Worker;
  const web = yield* Website;
  // In prod a zone route serves the web Worker on the main Worker's hostname, so it has no URL of its own. Previews
  // have no zone, so only prod declares the zone's rate limit.
  if (production) {
    yield* ZoneRateLimit;
    return { url: worker.url, webUrl: worker.url };
  }
  if (!hasDebug) return { url: worker.url, webUrl: web.url };

  const debug = yield* DebugWorker;
  const github = yield* GitHub.GitHubEnv;
  if (github?.pr !== undefined) {
    yield* GitHub.Comment("StageComment", {
      owner: github.owner,
      repository: github.repository,
      issueNumber: github.pr,
      body: Output.interpolate`
          ## Stage \`${stage}\`

          Worker: ${worker.url}
          Health: ${worker.url}/health
          Debug worker: ${debug.url}
          Web: ${web.url}
          OpenAPI: ${web.url}/openapi.json
          MCP: ${web.url}/mcp
        `,
    });
  }
  return {
    url: worker.url,
    webUrl: web.url,
    debugUrl: debug.url,
    debugToken: yield* DebugToken,
    // The preview workflow reads it to tell whether the stage must be recreated on another provider.
    aiProvider: yield* Effect.orDie(aiProvider),
  };
}).pipe(withStageConfig);

export default Alchemy.Stack(
  stackName,
  { providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers(), GitHub.providers()), state },
  app,
);
