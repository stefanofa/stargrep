import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { Client } from "pg";

class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable, { readonly brand: unique symbol }>()(
  "DatabaseUnavailable",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Postgres health check failed";
  }
}

interface DatabaseHealth {
  readonly postgres: string;
  readonly pgvector: string | null;
}

const checkDatabase = (connectionString: string) =>
  Effect.tryPromise(async () => {
    const t: Record<string, number> = {};
    let last = Date.now();
    const mark = (name: string) => {
      const now = Date.now();
      t[name] = now - last;
      last = now;
    };
    const client = new Client({ connectionString });
    client.on("error", () => {});
    await client.connect();
    mark("connect");
    await client.query("begin read only");
    mark("begin");
    const version = await client.query<{ version: string }>("select version()");
    mark("version");
    const vector = await client.query<{ extversion: string }>(
      "select extversion from pg_extension where extname = $1",
      ["vector"],
    );
    mark("vector");
    await client.query("commit");
    mark("commit");
    const single = await client.query("select version() as postgres, (select extversion from pg_extension where extname = $1) as pgvector", ["vector"]);
    mark("single");
    await client.end();
    mark("end");
    return { postgres: version.rows[0]?.version ?? "unknown", pgvector: vector.rows[0]?.extversion ?? null, single: single.rows.length, timings: t };
  }).pipe(Effect.mapError((cause) => new DatabaseUnavailable({ cause })));

export const healthResponse = (connectionString: string) =>
  checkDatabase(connectionString).pipe(
    Effect.flatMap((health) => HttpServerResponse.json(health)),
    Effect.catchTags({
      DatabaseUnavailable: (error) =>
        Effect.logError(error.message, error.cause).pipe(
          Effect.andThen(HttpServerResponse.json({ error: error.message }, { status: 503 })),
        ),
    }),
  );
