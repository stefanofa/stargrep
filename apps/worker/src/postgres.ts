import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Client } from "pg";

class PostgresFailed extends Schema.TaggedError<PostgresFailed, { readonly brand: unique symbol }>()("PostgresFailed", {
  operation: Schema.Literals(["health check", "transaction", "sleep"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Postgres ${this.operation} failed`;
  }
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

export const withClient = <A, E, R>(
  connectionString: string,
  operation: PostgresFailed["operation"],
  use: (client: Client) => Effect.Effect<A, E, R>,
) =>
  connect(connectionString).pipe(
    Effect.flatMap(use),
    Effect.scoped,
    // Changing this needs a new migration: 20261104172317_app_statement_timeout keeps the server's limit 1 s above it.
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) => new PostgresFailed({ operation, cause })),
  );
