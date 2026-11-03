import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { Database, DatabaseMigrations } from "./database.ts";
import { healthResponse } from "./health.ts";

export default class Worker extends Cloudflare.Worker<Worker>()(
  "Worker",
  // The Worker binds Hyperdrive by an ID that stays stable across updates, so Alchemy would deploy it
  // while the branch still migrates. Reading the applied migrations makes the deploy wait for them.
  Effect.map(DatabaseMigrations, (migrations) => ({ main: import.meta.url, env: { DATABASE_MIGRATIONS: migrations } })),
  Effect.gen(function* () {
    const database = yield* Cloudflare.Hyperdrive.Connect(Database);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.method === "GET" && new URL(request.url, "http://worker").pathname === "/health") {
          return yield* healthResponse(Redacted.value(yield* database.connectionString));
        }
        return HttpServerResponse.empty({ status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
