import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { withClient } from "./postgres.ts";

const decodeHealth = Schema.decodeUnknownEffect(
  Schema.Struct({ postgres: Schema.String, pgvector: Schema.NullOr(Schema.String) }),
);

export const healthResponse = (connectionString: string) =>
  withClient(connectionString, "health check", (client) =>
    Effect.tryPromise(() =>
      client.query(
        "select version() as postgres, (select extversion from pg_extension where extname = $1) as pgvector",
        ["vector"],
      ),
    ).pipe(Effect.flatMap(({ rows }) => decodeHealth(rows[0]))),
  ).pipe(
    Effect.flatMap((health) => HttpServerResponse.json(health)),
    Effect.catchTags({
      PostgresFailed: (error) =>
        Effect.logError(error.message, error.cause).pipe(
          Effect.andThen(HttpServerResponse.json({ error: error.message }, { status: 503 })),
        ),
    }),
    Effect.withSpan("Health.checkDatabase"),
  );
