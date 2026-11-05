export interface EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
  // The farthest cosine distance from a query at which search still counts a repo as a meaning match. It differs per
  // model, so docs/evals.md calibrates it for each one.
  readonly maxMatchDistance: number;
}

export const summaryModel = "anthropic/claude-haiku-5.5";

export const embeddingModel: EmbeddingModel = { id: "voyage/voyage-4", dimensions: 1024, maxMatchDistance: 0.36 };

export const plannerModel = "anthropic/claude-haiku-5.5";
