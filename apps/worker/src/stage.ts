import { names } from "@stargrep/auth/config";
import { withStageAi } from "@stargrep/runtime/ai-key";
import { stackName, stageSettings, webResourceId } from "@stargrep/runtime/stage";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Regex from "effect/RegExp";

export const settings = Effect.map(Alchemy.Stack, ({ stage }) => stageSettings(stage));

// Wraps the whole app stack, so every Worker reads the AI config its stage allows.
export const withStageConfig = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(settings, ({ stage }) => withStageAi(stage)(effect));

const workersSubdomain = "rewebdotso.workers.dev";
export const previewHost = new globalThis.RegExp(
  `^${stackName.toLowerCase()}-${webResourceId.toLowerCase()}-pr-\\d+-[a-z0-9]+\\.${Regex.escape(workersSubdomain)}$`,
);
export const previewHostBinding = {
  [names.previewHost]: JSON.stringify({ source: previewHost.source, flags: previewHost.flags }),
};
