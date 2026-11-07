import * as Layer from "effect/Layer";
import * as Fake from "./fake.ts";
import { keyMissingText } from "./gateway.ts";
import * as Models from "./models.ts";
import * as SummarizeFake from "./prompts/summarize.fake.ts";

// What a deployed stage that pays for no model calls uses in place of the gateway. A summary is the repo's description
// and the start of its README, an embedding hashes the words, and the planner has no key, so search runs the words as
// typed. Hash embeddings carry their own model ID, so they never land in a database that holds real ones.
export const layerModels = Layer.merge(
  Fake.layerTextGeneration(SummarizeFake.respond, "fake/summary"),
  Fake.layerEmbeddings(),
);

export const layerSearch = Layer.merge(keyMissingText(Models.plannerModel), Fake.layerEmbeddings());
