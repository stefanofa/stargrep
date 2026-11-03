import * as HttpEffect from "effect/http/HttpEffect";
import { healthResponse } from "../src/health.ts";

interface Env {
  readonly DATABASE: Hyperdrive;
  readonly UNREACHABLE_DATABASE: Hyperdrive;
}

export default {
  fetch: (request, env) => {
    const database = new URL(request.url).pathname === "/health" ? env.DATABASE : env.UNREACHABLE_DATABASE;
    return HttpEffect.toWebHandler(healthResponse(database.connectionString))(request);
  },
} satisfies ExportedHandler<Env>;
