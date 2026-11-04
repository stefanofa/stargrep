export interface EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
}

export const summaryModel = "anthropic/claude-haiku-5.5";

export const embeddingModel: EmbeddingModel = { id: "voyage/voyage-4", dimensions: 1024 };

export const plannerModel = "anthropic/claude-haiku-5.5";
