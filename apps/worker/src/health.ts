import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { Client } from "pg";

class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable, { readonly brand: unique symbol }>()(
  "DatabaseUnavailable",
  {
    operation: Schema.Literals(["health check", "transaction"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Postgres ${this.operation} failed`;
  }
}

const DatabaseHealth = Schema.Struct({ postgres: Schema.String, pgvector: Schema.NullOr(Schema.String) });
const TransactionResult = Schema.Struct({ pid: Schema.Int, sum: Schema.Int });

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

const rowResponse = <S extends Schema.Top>(
  operation: DatabaseUnavailable["operation"],
  connectionString: string,
  row: S,
  run: (client: Client) => Promise<unknown>,
) =>
  connect(connectionString).pipe(
    Effect.flatMap((client) => Effect.tryPromise(() => run(client))),
    Effect.flatMap(Schema.decodeUnknownEffect(row)),
    Effect.scoped,
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) => new DatabaseUnavailable({ operation, cause })),
    Effect.flatMap((value) => HttpServerResponse.json(value)),
    Effect.catchTags({
      DatabaseUnavailable: (error) =>
        Effect.logError(error.message, error.cause).pipe(
          Effect.andThen(HttpServerResponse.json({ error: error.message }, { status: 503 })),
        ),
    }),
  );

export const healthResponse = (connectionString: string) =>
  rowResponse("health check", connectionString, DatabaseHealth, async (client) => {
    const { rows } = await client.query(
      "select version() as postgres, (select extversion from pg_extension where extname = $1) as pgvector",
      ["vector"],
    );
    return rows[0];
  }).pipe(Effect.withSpan("Health.checkDatabase"));

export const transactionResponse = (connectionString: string) =>
  rowResponse("transaction", connectionString, TransactionResult, async (client) => {
    await client.query("begin");
    const { rows } = await client.query("select pg_backend_pid() as pid, $1::int + $2::int as sum", [20, 22]);
    await client.query("commit");
    return rows[0];
  }).pipe(Effect.withSpan("Health.runTransaction"));
