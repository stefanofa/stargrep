import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Models from "@stargrep/ai/models";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as Tracing from "@stargrep/telemetry/cloudflare";
import * as Telemetry from "alchemy/Telemetry";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { Database, DatabaseMigrations } from "./database.ts";
import { GitHubGate, githubToken } from "./github-gate.ts";
import { healthResponse } from "./health.ts";
import * as Layers from "./layers.ts";
import * as Queues from "./queues.ts";

const decodeModelId = Schema.decodeEffect(EmbeddingModelId);

export default class Worker extends Cloudflare.Worker<Worker>()(
  "Worker",
  // The Worker binds Hyperdrive by an ID that stays stable across updates, so Alchemy would deploy it
  // while the branch still migrates. Reading the applied migrations makes the deploy wait for them.
  // The placement region matches the Neon projects in infra/database.run.ts, so queries stay in one region.
  Effect.map(DatabaseMigrations, (migrations) => ({
    main: import.meta.url,
    env: { DATABASE_MIGRATIONS: migrations },
    placement: { region: "aws:us-east-1" },
    observability: { enabled: true, logs: { enabled: true, invocationLogs: true }, traces: { enabled: true } },
  })),
  Effect.gen(function* () {
    const database = yield* Cloudflare.Hyperdrive.Connect(Database);
    yield* Effect.orDie(githubToken);
    const runtime = Layers.layerRuntime({
      database: database.connectionString,
      readmes: yield* Cloudflare.R2.ReadWriteBucket(Layers.Readmes),
      enrichQueue: yield* Cloudflare.Queues.WriteQueue(yield* Queues.EnrichRepos),
      gates: yield* GitHubGate,
      aiGatewayKey: yield* Effect.orDie(Config.Redacted("AI_GATEWAY_API_KEY")),
      embeddingModel: yield* Effect.orDie(decodeModelId(Models.embeddingModel.id)),
      adopted: yield* Ref.make(false),
    });
    yield* Queues.consumeAll(runtime);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.method === "GET" && new URL(request.url, "http://worker").pathname === "/health") {
          return yield* healthResponse(Redacted.value(yield* database.connectionString));
        }
        return HttpServerResponse.empty({ status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.Hyperdrive.ConnectBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Queues.EventSourceLive,
        Telemetry.layer(Tracing.layer),
      ),
    ),
  ),
) {}
