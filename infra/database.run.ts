import * as Neon from "@alchemy.run/neon";
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
    // The main Worker's placement in apps/worker/src/worker.ts must match this region.
    const usEast = yield* Neon.Project("ProjectUsEast", {
      name: "stargrep-us-east",
      region: "aws-us-east-1",
      pgVersion: 17,
      historyRetentionSeconds: 21600,
    }).pipe(RemovalPolicy.retain());
    // Preview branches live in their own project, so a Neon key scoped to it can't reach prod's branch.
    const previewsUsEast = yield* Neon.Project("ProjectPreviewsUsEast", {
      name: "stargrep-previews-us-east",
      region: "aws-us-east-1",
      pgVersion: 17,
      historyRetentionSeconds: 0,
    }).pipe(RemovalPolicy.retain());
    return {
      usEastProjectId: usEast.projectId,
      previewsUsEastProjectId: previewsUsEast.projectId,
    };
  }),
);
