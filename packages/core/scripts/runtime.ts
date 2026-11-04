import * as Embeddings from "@stargrep/ai/embeddings";
import * as Local from "@stargrep/ai/local";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as GitHub from "@stargrep/github/github";
import { BudgetShare, Login, Repo, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as BlobStore from "../src/repos/blob-store.ts";
import * as EnrichRepo from "../src/repos/enrich-repo.ts";

export const spans: Array<Tracer.NativeSpan> = [];

export const tracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options);
    spans.push(span);
    return span;
  },
});

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

export const layerGitHub = <E, R>(cache: Layer.Layer<KeyValueStore.KeyValueStore, E, R>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const token = yield* Config.Redacted("GITHUB_TOKEN");
      return GitHub.layer.pipe(
        Layer.provideMerge(TokenGate.layerMemory({ token, share: BudgetShare.make(0.5) })),
        Layer.provide(layerCountedFetch),
        Layer.provide(cache),
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
  Layer.provideMerge(layerGitHub(KeyValueStore.layerFileSystem(".cache/github"))),
  Layer.provideMerge(BlobStore.layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerFileSystem(".cache/blobs")))),
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
