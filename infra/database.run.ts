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
    // A Neon project can't change region, so moving to the US takes a second project.
    const euCentral = yield* Neon.Project("Project", {
      name: "stargrep",
      region: "aws-eu-central-1",
      pgVersion: 17,
      historyRetentionSeconds: 21600,
    }).pipe(RemovalPolicy.retain());
    const usEast = yield* Neon.Project("ProjectUsEast", {
      name: "stargrep-us-east",
      region: "aws-us-east-1",
      pgVersion: 17,
      historyRetentionSeconds: 21600,
    }).pipe(RemovalPolicy.retain());
    // Preview branches live in their own project, so the preview Neon key can be scoped away from prod's branch.
    const previewsUsEast = yield* Neon.Project("ProjectPreviewsUsEast", {
      name: "stargrep-previews-us-east",
      region: "aws-us-east-1",
      pgVersion: 17,
      historyRetentionSeconds: 0,
    }).pipe(RemovalPolicy.retain());
    return {
      euCentralProjectId: euCentral.projectId,
      usEastProjectId: usEast.projectId,
      previewsUsEastProjectId: previewsUsEast.projectId,
    };
  }),
);
