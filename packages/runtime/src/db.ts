import * as Embeddings from "@stargrep/ai/embeddings";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const decodeModelId = Schema.decodeEffect(EmbeddingModelId);

export const layerDb = (options: Omit<Db.NodePostgresOptions, "embeddingModel">) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { model } = yield* Embeddings.Embeddings;
      return Db.layerNodePostgres({ ...options, embeddingModel: yield* Effect.orDie(decodeModelId(model.id)) });
    }),
  );
