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
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Schema from "effect/Schema";
import * as BlobStore from "../src/repos/blob-store.ts";

const requestMillis = new Map<string, Array<number>>();

const requestKind = (url: URL) =>
  url.pathname === "/graphql"
    ? "graphql"
    : url.pathname.includes("/git/blobs/")
      ? "readme"
      : (url.pathname.split("/")[1] ?? "");

export const githubRequests = Effect.sync(() =>
  [...requestMillis].map(([kind, millis]) => {
    const sorted = millis.toSorted((a, b) => a - b);
    return `${kind} ${millis.length} (median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted.at(-1)} ms)`;
  }),
).pipe(Effect.map((kinds) => `github requests: ${[...requestMillis.values()].flat().length}; ${kinds.join(", ")}`));

const layerCountedFetch = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    HttpClient.transformResponse(client, (response) =>
      Effect.gen(function* () {
        const [duration, result] = yield* Effect.timed(response);
        const kind = requestKind(new URL(result.request.url));
        requestMillis.set(kind, [...(requestMillis.get(kind) ?? []), Math.round(Duration.toMillis(duration))]);
        return result;
      }),
    ),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));

const layerGitHub = Layer.unwrap(
  Effect.gen(function* () {
    const token = yield* Config.Redacted("GITHUB_TOKEN");
    return GitHub.layer.pipe(
      Layer.provideMerge(TokenGate.layerMemory({ token, share: BudgetShare.make(0.5) })),
      Layer.provide(layerCountedFetch),
      Layer.provide(KeyValueStore.layerFileSystem(".cache/github")),
    );
  }),
);

const layerDb = Layer.unwrap(
  Effect.gen(function* () {
    const embeddings = yield* Embeddings.Embeddings;
    const connectionString = yield* Config.Redacted("DATABASE_URL");
    const embeddingModel = yield* Schema.decodeEffect(EmbeddingModelId)(embeddings.model.id);
    return Db.layerNodePostgres({ embeddingModel, connectionString });
  }),
);

export const layer = Layer.mergeAll(
  layerDb.pipe(Layer.provideMerge(Local.layer)),
  layerGitHub,
  BlobStore.layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerFileSystem(".cache/blobs"))),
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
