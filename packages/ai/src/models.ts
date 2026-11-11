export interface EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
  // The farthest cosine distance from a query at which search still counts a repo as a meaning match. It differs per
  // model, so docs/evals.md calibrates it for each one.
  readonly maxMatchDistance: number;
}

export const summaryModel = "anthropic/claude-haiku-5.5";

// The version of how a summary is made: the summary model, its prompt, and its output schema. Every summary stores the
// recipe that made it, and a bump makes every older summary due again while search keeps reading it. A bump needs a
// migration, because the partial enrichment index in packages/db names the current recipe.
export const summaryRecipe = 4;

export const embeddingModel: EmbeddingModel = { id: "voyage/voyage-4", dimensions: 1024, maxMatchDistance: 0.36 };

export const plannerModel = "anthropic/claude-haiku-5.5";
