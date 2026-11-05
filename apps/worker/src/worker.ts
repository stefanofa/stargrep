import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Tracing from "@stargrep/telemetry/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { budgetShareName, stageBudgetShare } from "./budget-share.ts";
import * as Crons from "./crons.ts";
import { Database, DatabaseMigrations } from "./database.ts";
import { prodWorkerHosting } from "./domain.ts";
import { tokenGate } from "./github-gate.ts";
import { healthResponse } from "./health.ts";
import * as Layers from "./layers.ts";
import * as Queues from "./queues.ts";
import { Readmes } from "./readmes.ts";
import { requireStageSecrets } from "./secrets.ts";

export default class Worker extends Cloudflare.Worker<Worker>()(
  "Worker",
  // The Worker binds Hyperdrive by an ID that stays stable across updates, so Alchemy would deploy it
  // while the branch still migrates. Reading the applied migrations makes the deploy wait for them.
  // The placement region matches the Neon projects in infra/database.run.ts, so queries stay in one region.
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    yield* requireStageSecrets(stage);
    return {
      main: import.meta.url,
      env: {
        DATABASE_MIGRATIONS: yield* DatabaseMigrations,
        [budgetShareName]: String(yield* stageBudgetShare(stage)),
      },
      placement: { region: "aws:us-east-1" },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true }, traces: { enabled: true } },
      ...(stage === "prod" ? prodWorkerHosting : {}),
    };
  }),
  Effect.gen(function* () {
    const database = yield* Cloudflare.Hyperdrive.Connect(Database);
    const runtime = Layers.layerRuntime({
      database: database.connectionString,
      readmes: yield* Cloudflare.R2.ReadWriteBucket(Readmes),
      enrichQueue: yield* Cloudflare.Queues.WriteQueue(yield* Queues.EnrichRepos),
      tokenGate: yield* tokenGate,
      ai: yield* Effect.orDie(Layers.aiModels),
      adopted: yield* Ref.make(false),
    });
    yield* Queues.consumeAll(runtime);
    yield* Crons.scheduleAll(runtime);
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
        Cloudflare.Workers.CronEventSourceLive,
        Tracing.layer,
      ),
    ),
  ),
) {}
