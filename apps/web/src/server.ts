import { env } from "cloudflare:workers";
import * as Tracing from "@stargrep/telemetry/cloudflare";
import start from "@tanstack/react-start/server-entry";
import type { WebEnv } from "./server/env.ts";
import { layerRequest } from "./server/layers.ts";
import { makeServer } from "./server/serve.ts";

const serve = makeServer((request, timing) => layerRequest(env as WebEnv, request, timing), Tracing.tracer);

export default {
  fetch: (request: Request) => serve(request) ?? start.fetch(request),
};
