import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import pg from "pg";
import * as Db from "../src/db.ts";
import { EmbeddingModelId } from "../src/embedding.ts";

// Runs the nightly topics refresh once, so a stage that just filled repo_topics with backfill-topics gets its topic
// pages without waiting for the cron. The Db layer checks the embedding model it is built with against the database's,
// so this reads the database's own model first and never stores another.
const storedModel = async (url: string) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ model: string }>("select model from embedding_settings");
    return Schema.decodeUnknownSync(EmbeddingModelId)(rows[0]?.model);
  } finally {
    await client.end();
  }
};

const program = Effect.gen(function* () {
  const url = process.env.DATABASE_URL;
  if (url === undefined) return yield* Effect.die(new Error("Set DATABASE_URL to the database to refresh"));
  const model = yield* Effect.promise(() => storedModel(url));
  const refreshed = yield* Db.Db.use((db) => db.topics.refresh()).pipe(
    Effect.provide(Db.layerNodePostgres({ connectionString: Redacted.make(url), embeddingModel: model })),
  );
  yield* Console.log("Topics refreshed", refreshed);
});

Effect.runPromise(program);
