export interface EmbeddingModel {
  readonly id: string;
  readonly dimensions: number;
}

export const summaryModel = "anthropic/claude-haiku-5.5";

export const embeddingModel: EmbeddingModel = { id: "openai/text-embedding-3-small", dimensions: 1024 };
