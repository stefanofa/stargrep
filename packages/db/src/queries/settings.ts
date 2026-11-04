import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { EmbeddingModelConflict, EmbeddingModelId, embeddingDimensions } from "../embedding.ts";
import * as Postgres from "../postgres.ts";
import { rowsDecoder } from "../rows.ts";
import { embeddingSettings } from "../schema.ts";

const Settings = createSelectSchema(embeddingSettings, { model: EmbeddingModelId });
const decodeSettings = rowsDecoder(Settings);

const read = Effect.gen(function* () {
  const { run } = yield* Postgres.Postgres;
  return yield* run("settings.adopt", (db) => db.select().from(embeddingSettings)).pipe(
    Effect.flatMap(decodeSettings("settings.adopt")),
    Effect.map(Arr.head),
  );
});

export const adopt = Effect.fn("Db.settings.adopt")(function* (configured: EmbeddingModelId) {
  const { run } = yield* Postgres.Postgres;
  const current = yield* read;
  if (Option.isNone(current)) {
    yield* run("settings.adopt", (db) =>
      db.insert(embeddingSettings).values({ model: configured, dimensions: embeddingDimensions }).onConflictDoNothing(),
    );
  }
  const stored = Option.isSome(current)
    ? current.value
    : yield* read.pipe(
        Effect.flatMap(
          Option.match({ onNone: () => Effect.die("embedding_settings has no row"), onSome: Effect.succeed }),
        ),
      );
  if (stored.model !== configured || stored.dimensions !== embeddingDimensions) {
    return yield* new EmbeddingModelConflict({
      stored: stored.model,
      storedDimensions: stored.dimensions,
      configured,
      configuredDimensions: embeddingDimensions,
    });
  }
  return stored.model;
});
