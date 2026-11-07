import * as Neon from "@alchemy.run/neon";
import { stageSettings } from "@stargrep/runtime/stage";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import { state } from "./state.ts";

export default Alchemy.Stack(
  "StargrepDatabase",
  { providers: Neon.providers(), state },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    if (stage !== "shared") {
      return yield* Effect.die(new Error(`Deploy the database stack only to stage "shared", not "${stage}"`));
    }
    const production = stageSettings("prod").database;
    const previews = stageSettings("pr-0").database;
    const usEast = yield* Neon.Project(production.logicalId, {
      name: production.name,
      region: production.region,
      pgVersion: production.pgVersion,
      historyRetentionSeconds: production.historyRetentionSeconds,
    }).pipe(RemovalPolicy.retain());
    // Preview branches live in their own project, so a Neon key scoped to it can't reach prod's branch.
    const previewsUsEast = yield* Neon.Project(previews.logicalId, {
      name: previews.name,
      region: previews.region,
      pgVersion: previews.pgVersion,
      historyRetentionSeconds: previews.historyRetentionSeconds,
    }).pipe(RemovalPolicy.retain());
    return {
      usEastProjectId: usEast.projectId,
      previewsUsEastProjectId: previewsUsEast.projectId,
    };
  }),
);
