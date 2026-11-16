import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { type AiError, AiOutputInvalid, AiTimeout } from "./errors.ts";
import type { EmbeddingModel } from "./models.ts";
import { annotateTokens, countTokens, recordCall } from "./port.ts";

export interface Embedding {
  readonly model: string;
  readonly vector: ReadonlyArray<number>;
}

export interface EmbedResult {
  readonly vectors: ReadonlyArray<ReadonlyArray<number>>;
  readonly tokens: number | undefined;
  // What the provider billed, when it says.
  readonly costUsd?: number | undefined;
}

export class Embeddings extends Context.Service<
  Embeddings,
  {
    readonly model: EmbeddingModel;
    readonly embed: (values: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Embedding>, AiError>;
  }
>()("@stargrep/ai/embeddings") {}

export const make = (options: {
  readonly provider: string;
  readonly model: EmbeddingModel;
  // What the vectors are for, such as a repo or a query, so analytics can tell their spend apart.
  readonly purpose?: string;
  readonly timeout: Duration.Duration;
  readonly run: (values: ReadonlyArray<string>) => Effect.Effect<EmbedResult, AiError>;
}) => {
  const { provider, model, timeout, run } = options;
  const timedOut = new AiTimeout({ operation: "embed", model: model.id, timeoutMillis: Duration.toMillis(timeout) });
  const call = { operation: "embed", purpose: options.purpose ?? "embed", provider, model: model.id } as const;
  const embed = Effect.fnUntraced(
    function* (values: ReadonlyArray<string>) {
      const { vectors, tokens } = yield* run(values).pipe(
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(timedOut) }),
        recordCall(call, (result: EmbedResult) => ({ inputTokens: result.tokens, costUsd: result.costUsd })),
      );
      yield* countTokens(model.id, "input", tokens);
      yield* annotateTokens({ input: tokens });
      const wrongSize = vectors.find((vector) => vector.length !== model.dimensions);
      if (vectors.length !== values.length || wrongSize !== undefined) {
        return yield* new AiOutputInvalid({
          operation: "embed",
          model: model.id,
          detail: `expected ${values.length} vectors of ${model.dimensions} dimensions, got ${vectors.length} with ${wrongSize?.length ?? model.dimensions}`,
        });
      }
      return vectors.map((vector): Embedding => ({ model: model.id, vector }));
    },
    Effect.withSpan("Embeddings.embed", { attributes: { provider, model: model.id } }),
  );
  return Embeddings.of({ model, embed });
};
