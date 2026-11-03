import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "StargrepDatabase",
  { providers: Neon.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    if (stage !== "shared") {
      return yield* Effect.die(new Error(`Deploy the database stack only to stage "shared", not "${stage}"`));
    }
    const project = yield* Neon.Project("Project", {
      name: "stargrep",
      region: "aws-eu-central-1",
      pgVersion: 17,
    }).pipe(RemovalPolicy.retain());
    return { projectId: project.projectId };
  }),
);
