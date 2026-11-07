import * as Cloudflare from "@alchemy.run/cloudflare";
import { tokenConfig } from "@stargrep/auth/config";
import * as Tokens from "@stargrep/auth/tokens";
import * as GitHub from "@stargrep/github/github";
import {
  budgetShare,
  budgetShareName,
  requireStageSecrets,
  serverTokenName,
  serverTokenPolicy,
} from "@stargrep/runtime/server-token";
import * as Tracing from "@stargrep/telemetry/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { tokenBindings } from "./auth.ts";
import * as Crons from "./crons.ts";
import { Database, DatabaseMigrations } from "./database.ts";
import { prodWorkerHosting } from "./domain.ts";
import { tokenGate, UserGitHubGate } from "./github-gate.ts";
import { healthResponse } from "./health.ts";
import { Icons } from "./icons/bucket.ts";
import * as Layers from "./layers.ts";
import * as OwnerLookup from "./owner-lookup.ts";
import * as Queues from "./queues.ts";
import { Readmes } from "./readmes.ts";
import { settings } from "./stage.ts";
import * as UserGate from "./user-gate.ts";

export default class Worker extends Cloudflare.Worker<Worker>()(
  "Worker",
  // The Worker binds Hyperdrive by an ID that stays stable across updates, so Alchemy would deploy it
  // while the branch still migrates. Reading the applied migrations makes the deploy wait for them.
  // The placement region matches the Neon projects in infra/database.run.ts, so queries stay in one region.
  Effect.gen(function* () {
    const { stage, production, placement } = yield* settings;
    const { kind, share } = yield* serverTokenPolicy(stage);
    yield* requireStageSecrets(stage, kind);
    return {
      main: import.meta.url,
      env: {
        DATABASE_MIGRATIONS: yield* DatabaseMigrations,
        [budgetShareName]: String(share),
        [serverTokenName]: kind,
        ...(yield* tokenBindings(stage)),
      },
      placement,
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true }, traces: { enabled: true } },
      ...(production ? prodWorkerHosting : {}),
    };
  }),
  Effect.gen(function* () {
    const database = yield* Cloudflare.Hyperdrive.Connect(Database);
    const iconQueue = yield* Cloudflare.Queues.WriteQueue(yield* Queues.FetchIcons);
    const gate = yield* tokenGate;
    const userGitHubGates = yield* UserGitHubGate;
    const userGates = Option.match(yield* Effect.orDie(tokenConfig), {
      onNone: () => UserGate.layerServerOnly,
      onSome: (config) =>
        UserGate.layer(userGitHubGates).pipe(Layer.provide(Tokens.layer(config, database.connectionString))),
    });
    const runtime = Layers.layerRuntime({
      database: database.connectionString,
      readmes: yield* Cloudflare.R2.ReadWriteBucket(Readmes),
      icons: yield* Cloudflare.R2.ReadWriteBucket(Icons),
      enrichQueue: yield* Cloudflare.Queues.WriteQueue(yield* Queues.EnrichRepos),
      iconQueue,
      tokenGate: gate,
      userGates,
      ai: yield* Effect.orDie(Layers.aiModels),
      adopted: yield* Ref.make(false),
    });
    yield* Queues.consumeAll(runtime, yield* Effect.orDie(budgetShare));
    yield* Crons.scheduleAll(runtime);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.method === "GET" && new URL(request.url, "http://worker").pathname === "/health") {
          return yield* healthResponse(Redacted.value(yield* database.connectionString));
        }
        return HttpServerResponse.empty({ status: 404 });
      }).pipe(Effect.orDie),
      lookupOwner: OwnerLookup.lookupOwner(GitHub.layer.pipe(Layer.provide(gate))),
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
