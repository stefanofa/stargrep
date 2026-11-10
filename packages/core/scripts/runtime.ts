import * as Batches from "@stargrep/ai/batches";
import * as Embeddings from "@stargrep/ai/embeddings";
import { AiRequestFailed } from "@stargrep/ai/errors";
import * as Gateway from "@stargrep/ai/gateway";
import * as Local from "@stargrep/ai/local";
import * as Models from "@stargrep/ai/models";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as GitHub from "@stargrep/github/github";
import { BudgetShare, Login, Repo, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import * as TokenGate from "@stargrep/github/token-gate";
import { collectSpans } from "@stargrep/telemetry/collector";
import { withoutResults } from "@stargrep/telemetry/tracer";
import { S3Client } from "bun";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as IconQueue from "../src/icons/icon-queue.ts";
import * as BlobStore from "../src/repos/blob-store.ts";
import * as EnrichRepo from "../src/repos/enrich-repo.ts";
import * as Prefill from "../src/repos/prefill.ts";

export const { spans, tracer } = collectSpans();

export const millis = (nanos: bigint) => Number(nanos / 1_000_000n);

export const ended = (name: string) =>
  spans.flatMap((span) =>
    span.name === name && span.status._tag === "Ended" && Exit.isSuccess(span.status.exit) ? [span.status] : [],
  );

export const spentMillis = (name: string) =>
  spans.reduce(
    (total, span) =>
      span.name === name && span.status._tag === "Ended"
        ? total + millis(span.status.endTime - span.status.startTime)
        : total,
    0,
  );

export const requests = { count: 0, millis: new Map<string, Array<number>>() };

const requestKind = (url: URL) =>
  url.pathname === "/graphql"
    ? "graphql"
    : url.pathname.includes("/git/blobs/")
      ? "readme"
      : (url.pathname.split("/")[1] ?? "");

export const requestSummary = () =>
  [...requests.millis]
    .map(([kind, timings]) => {
      const sorted = timings.toSorted((a, b) => a - b);
      return `${kind} ${timings.length} (median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms)`;
    })
    .join(", ");

const layerCountedFetch = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.tapRequest(client, () => Effect.sync(() => requests.count++)).pipe(
      HttpClient.transformResponse((response) =>
        Effect.gen(function* () {
          const [duration, result] = yield* Effect.timed(response);
          const kind = requestKind(new URL(result.request.url));
          requests.millis.set(kind, [...(requests.millis.get(kind) ?? []), Math.round(Duration.toMillis(duration))]);
          return result;
        }),
      ),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

export const layerGitHub = Layer.unwrap(
  Effect.gen(function* () {
    const token = yield* Config.Redacted("GITHUB_TOKEN");
    return GitHub.layer.pipe(
      Layer.provideMerge(TokenGate.layerMemory({ token, share: BudgetShare.make(0.5) })),
      Layer.provide(layerCountedFetch),
    );
  }),
);

const decodeModelId = Schema.decodeEffect(EmbeddingModelId);

export const layerDb = (embeddingModel: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      return Db.layerNodePostgres({
        connectionString: yield* Config.Redacted("DATABASE_URL"),
        embeddingModel: yield* decodeModelId(embeddingModel),
      });
    }),
  );

export const layerEnrich = EnrichRepo.layer.pipe(
  Layer.provideMerge(Layer.unwrap(Effect.map(Embeddings.Embeddings, (embeddings) => layerDb(embeddings.model.id)))),
  Layer.provideMerge(Local.layer),
  Layer.provideMerge(layerGitHub),
  Layer.provideMerge(BlobStore.layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerFileSystem(".cache/blobs")))),
  Layer.provideMerge(IconQueue.layerMemory().layer),
);

export const storeRefs = Effect.fn("scripts.storeRefs")(function* (repos: ReadonlyArray<Repo>) {
  const db = yield* Db.Db;
  yield* db.repos.upsertRefs(repos);
  return repos.map((repo) => repo.id);
});

const RepoResponse = Schema.fromJsonString(
  Schema.Struct({ id: RepoId, node_id: RepoNodeId, name: RepoName, owner: Schema.Struct({ login: Login }) }),
);
const decodeRepoResponse = Schema.decodeUnknownEffect(RepoResponse);

export class RepoNotResolved extends Schema.TaggedError<RepoNotResolved, { readonly brand: unique symbol }>()(
  "RepoNotResolved",
  { fullName: Schema.String, status: Schema.Int },
) {
  override get message(): string {
    return `GitHub has no repo '${this.fullName}' this token can read (status ${this.status})`;
  }
}

export const resolveRepo = Effect.fn("scripts.resolveRepo")(function* (fullName: string) {
  const gate = yield* TokenGate.TokenGate;
  const reply = yield* gate.execute(
    "repo-facts",
    HttpClientRequest.get(`https://api.github.com/repos/${fullName}`).pipe(
      HttpClientRequest.setHeaders({ "x-github-api-version": "2022-11-28", "user-agent": "stargrep" }),
    ),
  );
  if (reply.status !== 200 || Option.isNone(reply.body)) {
    return yield* new RepoNotResolved({ fullName, status: reply.status });
  }
  const body = yield* decodeRepoResponse(reply.body.value);
  return Repo.make({ id: body.id, nodeId: body.node_id, owner: body.owner.login, name: body.name });
});

// Span counts by name, kept as counts only, so a run over 100k repos holds no spans. Db.<operation> counts statements.
export const spanCounts = new Map<string, number>();
export const countingTracer = withoutResults(
  Tracer.make({
    span: (options) => {
      spanCounts.set(options.name, (spanCounts.get(options.name) ?? 0) + 1);
      return new Tracer.NativeSpan(options);
    },
  }),
);

export const statementCounts = () =>
  [...spanCounts]
    .filter(([name]) => name.startsWith("Db.") && name !== "Db.transaction")
    .toSorted(([a], [b]) => a.localeCompare(b));

// READMEs and prefill request objects: the stage's R2 bucket through its S3 API when PREFILL_R2_BUCKET names one, and a
// local directory otherwise. The Worker reads READMEs from the same keys.
export const layerBlobs = Layer.unwrap(
  Effect.gen(function* () {
    const bucket = yield* Config.option(Config.String("PREFILL_R2_BUCKET"));
    if (Option.isNone(bucket)) {
      return BlobStore.layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerFileSystem(".cache/blobs")));
    }
    const client = new S3Client({
      bucket: bucket.value,
      endpoint: `https://${yield* Config.String("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
      accessKeyId: Redacted.value(yield* Config.Redacted("R2_ACCESS_KEY_ID")),
      secretAccessKey: Redacted.value(yield* Config.Redacted("R2_SECRET_ACCESS_KEY")),
    });
    return Layer.succeed(BlobStore.BlobStore, layerS3(client));
  }),
);

// The part of Bun's S3 client the blob store uses.
export interface ObjectBucket {
  readonly file: (key: string) => { readonly exists: () => Promise<boolean>; readonly text: () => Promise<string> };
  readonly write: (key: string, value: string) => Promise<number>;
}

export const layerS3 = (client: ObjectBucket) =>
  BlobStore.BlobStore.of({
    get: Effect.fn("BlobStore.get")(function* (key: string) {
      return yield* Effect.tryPromise({
        try: async () => {
          const file = client.file(key);
          return (await file.exists()) ? Option.some(await file.text()) : Option.none<string>();
        },
        catch: (cause) => new BlobStore.BlobStoreFailed({ operation: "get", key, cause }),
      });
    }),
    put: Effect.fn("BlobStore.put")(function* (key: string, value: string) {
      yield* Effect.tryPromise({
        try: () => client.write(key, value),
        catch: (cause) => new BlobStore.BlobStoreFailed({ operation: "put", key, cause }),
      });
    }),
  });

const StandInBatch = Schema.fromJsonString(
  Schema.Struct({
    // Each prompt's first line, which names its repo, so a check can tell whether a repo was paid for twice.
    repos: Schema.Array(Schema.String),
    outputs: Schema.Array(Schema.Unknown),
  }),
);
export const StandInBatchJson = StandInBatch;
export const SubmissionJson = Schema.fromJsonString(
  Schema.Struct({ key: Schema.String, replayed: Schema.Boolean, prompts: Schema.Int }),
);

// The stand-in's batch API for local and preview runs. It answers as the stand-in summary does and keeps each batch in
// a file named by its idempotency key, so a rerun of a killed process finds its batch again, as the Gateway would. Every
// submit leaves a submissions/ entry that says whether it replayed one.
export const layerStandInBatches = (dir: string) =>
  Layer.effect(
    Batches.Batches,
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const unreadable = () =>
        new AiRequestFailed({ operation: "generate", model: "fake/summary", detail: "stand-in batch unreadable" });
      return Batches.Batches.of({
        provider: "fake",
        model: "fake/summary",
        submit: Effect.fn("StandInBatches.submit")(function* (request: Batches.BatchRequest) {
          const key = yield* Batches.requestKey(request);
          const replayed = yield* store.has(key).pipe(Effect.mapError(unreadable));
          if (!replayed) {
            const batch = yield* Schema.encodeEffect(StandInBatch)({
              repos: request.prompts.map((prompt) => prompt.slice(0, prompt.indexOf("\n"))),
              outputs: request.prompts.map(SummarizeFake.respond),
            }).pipe(Effect.orDie);
            yield* store.set(key, batch).pipe(Effect.mapError(unreadable));
          }
          const entry = yield* Schema.encodeEffect(SubmissionJson)({
            key,
            replayed,
            prompts: request.prompts.length,
          }).pipe(Effect.orDie);
          yield* store
            .set(`submissions/${yield* Clock.currentTimeMillis}-${key.slice(-16)}`, entry)
            .pipe(Effect.mapError(unreadable));
          return key;
        }),
        collect: Effect.fn("StandInBatches.collect")(function* (batchId: string, size: number) {
          const text = yield* store.get(batchId).pipe(Effect.mapError(unreadable));
          if (text === undefined) return yield* unreadable();
          const batch = yield* Schema.decodeEffect(StandInBatch)(text).pipe(Effect.mapError(unreadable));
          return Array.from({ length: size }, (_, index) =>
            index < batch.outputs.length
              ? Result.succeed({
                  output: batch.outputs[index],
                  usage: { inputTokens: undefined, outputTokens: undefined },
                })
              : undefined,
          );
        }),
      });
    }),
  ).pipe(Layer.provide(KeyValueStore.layerFileSystem(dir)));

const noBatchApi = Layer.succeed(
  Batches.Batches,
  Batches.Batches.of({
    provider: "claude-code",
    model: "claude-code",
    submit: Effect.fn("NoBatches.submit")(function* () {
      return yield* new AiRequestFailed({ operation: "generate", model: "claude-code", detail: "no batch API" });
    }),
    collect: Effect.fn("NoBatches.collect")(function* () {
      return yield* new AiRequestFailed({ operation: "generate", model: "claude-code", detail: "no batch API" });
    }),
  }),
);

// The batch API that matches AI_TEXT_PROVIDER: the Gateway's, the stand-in's, or none for the Claude Code CLI.
export const layerBatches = Layer.unwrap(
  Effect.gen(function* () {
    const provider = yield* Config.String("AI_TEXT_PROVIDER").pipe(Config.withDefault("gateway"));
    const standIn = yield* Config.String("PREFILL_STAND_IN_DIR").pipe(Config.withDefault(".cache/stand-in-batches"));
    const layers: Record<
      string,
      Layer.Layer<Batches.Batches, PlatformError.PlatformError | Config.ConfigError, FileSystem.FileSystem | Path.Path>
    > = {
      fake: layerStandInBatches(standIn),
      "claude-code": noBatchApi,
    };
    return (
      layers[provider] ?? Gateway.layerBatches(Models.summaryModel).pipe(Layer.provide(Gateway.layerProviderConfig))
    );
  }),
);

export const layerPrefill = Layer.mergeAll(Prefill.layer, EnrichRepo.layer).pipe(
  Layer.provideMerge(Layer.unwrap(Effect.map(Embeddings.Embeddings, (embeddings) => layerDb(embeddings.model.id)))),
  Layer.provideMerge(Local.layer),
  Layer.provideMerge(layerBatches),
  Layer.provideMerge(layerGitHub),
  Layer.provideMerge(layerBlobs),
  Layer.provideMerge(IconQueue.layerMemory().layer),
);
