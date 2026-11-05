export interface EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
}

export const summaryModel = "anthropic/claude-haiku-5.5";

export const embeddingModel: EmbeddingModel = { id: "voyage/voyage-4", dimensions: 1024 };

// Calibrated for embeddingModel in docs/evals.md. Recalibrate it whenever that model changes.
export const maxMatchDistance = 0.36;

export const plannerModel = "anthropic/claude-haiku-5.5";
