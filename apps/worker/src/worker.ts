import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import { Database } from "./database.ts";
import { healthResponse } from "./health.ts";

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.url },
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
);
