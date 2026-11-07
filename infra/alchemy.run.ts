// @effect-diagnostics layerMergeAllWithDependencies:off - the stack supplies HttpClient to every provider layer.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Neon from "@alchemy.run/neon";
import { stackName } from "@stargrep/runtime/stage";
import { Website } from "@stargrep/web/website";
import Worker from "@stargrep/worker";
import DebugWorker, { DebugToken } from "@stargrep/worker/debug";
import { ZoneRateLimit } from "@stargrep/worker/domain";
import { settings } from "@stargrep/worker/stage";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { state } from "./state.ts";

export default Alchemy.Stack(
  stackName,
  { providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers(), GitHub.providers()), state },
  Effect.gen(function* () {
    const { stage, debug: hasDebug } = yield* settings;
    const worker = yield* Worker;
    const web = yield* Website;
    // In prod a zone route serves the web Worker on the main Worker's hostname, so it has no URL of its own. Previews
    // have no zone, so only prod declares the zone's rate limit.
    if (!hasDebug) {
      yield* ZoneRateLimit;
      return { url: worker.url, webUrl: worker.url };
    }

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
    return { url: worker.url, webUrl: web.url, debugUrl: debug.url, debugToken: yield* DebugToken };
  }),
);
