export interface EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
}

export const summaryModel = "openai/gpt-6-luna";

export const embeddingModel: EmbeddingModel = { id: "voyage/voyage-4", dimensions: 1024 };
