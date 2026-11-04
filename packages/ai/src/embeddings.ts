import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { type AiError, AiOutputInvalid, AiTimeout } from "./errors.ts";
import type { EmbeddingModel } from "./models.ts";
import { countTokens, portSpan, unavailableRetry } from "./port.ts";

export interface Embedding {
  readonly model: string;
  readonly vector: ReadonlyArray<number>;
}

export interface EmbedResult {
  readonly vectors: ReadonlyArray<ReadonlyArray<number>>;
  readonly tokens: number | undefined;
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
  readonly timeout: Duration.Duration;
  readonly run: (values: ReadonlyArray<string>) => Effect.Effect<EmbedResult, AiError>;
}) => {
  const { provider, model, timeout, run } = options;
  const timedOut = new AiTimeout({ operation: "embed", model: model.id, timeoutMillis: Duration.toMillis(timeout) });
  const embed = Effect.fnUntraced(
    function* (values: ReadonlyArray<string>) {
      const { vectors, tokens } = yield* run(values).pipe(
        Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(timedOut) }),
        Effect.retry(unavailableRetry),
      );
      yield* countTokens(model.id, "input", tokens);
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
    portSpan("Embeddings.embed", { provider, model: model.id }),
  );
  return Embeddings.of({ model, embed });
};
