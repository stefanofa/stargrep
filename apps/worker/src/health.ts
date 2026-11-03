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

const connect = (connectionString: string) =>
  Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const client = new Client({ connectionString });
      // On workerd, end() closes the socket under pg's read loop, which pg reports as a client error event.
      // A real failure still rejects the pending query, so the event needs a listener, not a handler.
      client.on("error", () => {});
      await client.connect();
      return client;
    }),
    (client) => Effect.promise(() => client.end()).pipe(Effect.ignore),
  );

const checkDatabase = Effect.fn("Health.checkDatabase")(
  function* (connectionString: string) {
    const client = yield* connect(connectionString);
    return yield* Effect.tryPromise(async (): Promise<DatabaseHealth> => {
      await client.query("begin read only");
      const version = await client.query<{ version: string }>("select version()");
      const vector = await client.query<{ extversion: string }>(
        "select extversion from pg_extension where extname = $1",
        ["vector"],
      );
      await client.query("commit");
      return { postgres: version.rows[0]?.version ?? "unknown", pgvector: vector.rows[0]?.extversion ?? null };
    });
  },
  Effect.scoped,
  Effect.timeout("10 seconds"),
  Effect.mapError((cause) => new DatabaseUnavailable({ cause })),
);

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
