// @effect-diagnostics layerMergeAllWithDependencies:off - the stack supplies HttpClient to every provider layer.
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Neon from "@alchemy.run/neon";
import Worker from "@stargrep/worker";
import DebugWorker, { DebugToken } from "@stargrep/worker/debug";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { state } from "./state.ts";

export default Alchemy.Stack(
  "Stargrep",
  { providers: Layer.mergeAll(Cloudflare.providers(), Neon.providers(), GitHub.providers()), state },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const worker = yield* Worker;
    if (stage === "prod") return { url: worker.url };

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
        `,
      });
    }
    return { url: worker.url, debugUrl: debug.url, debugToken: yield* DebugToken };
  }),
);
