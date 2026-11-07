import { names } from "@stargrep/auth/config";
import { stackName, stageSettings, webResourceId } from "@stargrep/runtime/stage";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Regex from "effect/RegExp";

export const settings = Effect.map(Alchemy.Stack, ({ stage }) => stageSettings(stage));

const workersSubdomain = "rewebdotso.workers.dev";
export const previewHost = new globalThis.RegExp(
  `^${stackName.toLowerCase()}-${webResourceId.toLowerCase()}-pr-\\d+-[a-z0-9]+\\.${Regex.escape(workersSubdomain)}$`,
);
export const previewHostBinding = {
  [names.previewHost]: JSON.stringify({ source: previewHost.source, flags: previewHost.flags }),
};
