import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { connect } from "./postgres.ts";

class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable, { readonly brand: unique symbol }>()(
  "DatabaseUnavailable",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Postgres health check failed";
  }
}

const DatabaseHealth = Schema.Struct({ postgres: Schema.String, pgvector: Schema.NullOr(Schema.String) });

export const healthResponse = (connectionString: string) =>
  connect(connectionString).pipe(
    Effect.flatMap((client) =>
      Effect.tryPromise(() =>
        client.query(
          "select version() as postgres, (select extversion from pg_extension where extname = $1) as pgvector",
          ["vector"],
        ),
      ),
    ),
    Effect.flatMap(({ rows }) => Schema.decodeUnknownEffect(DatabaseHealth)(rows[0])),
    Effect.scoped,
    Effect.timeout("10 seconds"),
    Effect.mapError((cause) => new DatabaseUnavailable({ cause })),
    Effect.flatMap((health) => HttpServerResponse.json(health)),
    Effect.catchTags({
      DatabaseUnavailable: (error) =>
        Effect.logError(error.message, error.cause).pipe(
          Effect.andThen(HttpServerResponse.json({ error: error.message }, { status: 503 })),
        ),
    }),
    Effect.withSpan("Health.checkDatabase"),
  );
