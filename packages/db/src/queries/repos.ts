import { Repo as GitHubRepo, Login, ObjectId, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import { and, eq, getColumns, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { type Embedding, EmbeddingModelId, type EmbeddingModelMismatch, requireModel } from "../embedding.ts";
import { type DbQueryFailed, type DbRowInvalid, RepoNotFound } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { excluded, NullableTime, requireRow, rowsDecoder, writeEncoder } from "../rows.ts";
import { repoMetrics, repos } from "../schema.ts";

const RepoRow = createSelectSchema(repos, {
  id: RepoId,
  owner: Login,
  name: RepoName,
  nodeId: Schema.NullOr(RepoNodeId),
  topics: Schema.Array(Schema.String),
  createdAt: NullableTime,
  pushedAt: NullableTime,
  readmeOid: Schema.NullOr(ObjectId),
  summaryReadmeOid: Schema.NullOr(ObjectId),
  keywords: Schema.Array(Schema.String),
  embeddingModel: Schema.NullOr(EmbeddingModelId),
});

export const Repo = Schema.Struct(Struct.omit(RepoRow.fields, ["embedding", "search"]));
export type Repo = typeof Repo.Type;

const { embedding: _embedding, search: _search, ...columns } = getColumns(repos);
export const repoColumns = columns;

const RepoRef = GitHubRepo;
export type RepoRef = typeof RepoRef.Type;

const RepoFacts = Schema.Struct(
  Struct.pick(Repo.fields, [
    "id",
    "owner",
    "name",
    "description",
    "topics",
    "language",
    "license",
    "homepage",
    "createdAt",
    "pushedAt",
    "archived",
    "readmeOid",
  ]),
);
export type RepoFacts = typeof RepoFacts.Type;

export interface RepoCounts {
  readonly id: RepoId;
  readonly stars: number;
  readonly forks: number;
}

const RepoSummary = Schema.Struct({
  ...Struct.pick(Repo.fields, ["id", "readmeOid", "keywords"]),
  summary: Schema.String,
  kind: Schema.String,
});
export type RepoSummary = typeof RepoSummary.Type;

export interface RepoEmbedding {
  readonly id: RepoId;
  readonly embedding: Embedding;
  readonly summary: string;
  readonly readmeOid: ObjectId | null;
}

const StoredRepo = Schema.Struct({ ...Repo.fields, pending: Schema.Boolean });
export type StoredRepo = typeof StoredRepo.Type;

export interface Queries {
  readonly upsertRefs: (refs: ReadonlyArray<RepoRef>) => Effect.Effect<void, DbQueryFailed>;
  readonly pendingEnrichment: (
    ids: ReadonlyArray<RepoId>,
  ) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
  readonly saveFacts: (facts: RepoFacts) => Effect.Effect<{ readonly pending: boolean }, DbQueryFailed | DbRowInvalid>;
  readonly saveCounts: (counts: RepoCounts) => Effect.Effect<void, DbQueryFailed>;
  readonly saveSummary: (summary: RepoSummary) => Effect.Effect<boolean, DbQueryFailed | RepoNotFound>;
  readonly saveEmbedding: (
    input: RepoEmbedding,
  ) => Effect.Effect<boolean, DbQueryFailed | RepoNotFound | EmbeddingModelMismatch>;
  readonly get: (id: RepoId) => Effect.Effect<Option.Option<Repo>, DbQueryFailed | DbRowInvalid>;
  readonly require: (id: RepoId) => Effect.Effect<Repo, DbQueryFailed | DbRowInvalid | RepoNotFound>;
  readonly getMany: (
    ids: ReadonlyArray<RepoId>,
  ) => Effect.Effect<ReadonlyArray<StoredRepo>, DbQueryFailed | DbRowInvalid>;
}

const batchSize = 1000;
const decodeRepos = rowsDecoder(Repo);
const decodeIds = rowsDecoder(Schema.Struct({ id: RepoId }));
const decodeStored = rowsDecoder(StoredRepo);
const decodePending = rowsDecoder(Schema.Struct({ pending: Schema.Boolean }));

const needsEnrichment = sql<boolean>`(${repos.summary} is null or ${repos.summaryReadmeOid} is distinct from ${repos.readmeOid} or ${repos.embeddingModel} is null)`;
const encodeRefs = writeEncoder(Schema.Array(RepoRef));
const encodeFacts = writeEncoder(RepoFacts);
const encodeSummary = writeEncoder(RepoSummary);

const repoFound = (id: RepoId) => requireRow(() => new RepoNotFound({ repoId: id }));

export const make = Effect.fn("Db.repos.make")(function* (configuredModel: EmbeddingModelId) {
  const { run, withTransaction } = yield* Postgres.Postgres;

  const applied =
    (operation: "repos.saveSummary" | "repos.saveEmbedding", id: RepoId) =>
    (rows: ReadonlyArray<unknown>): Effect.Effect<boolean, DbQueryFailed | RepoNotFound> =>
      rows.length > 0
        ? Effect.succeed(true)
        : run(operation, (db) => db.select({ id: repos.id }).from(repos).where(eq(repos.id, id))).pipe(
            Effect.flatMap(repoFound(id)),
            Effect.as(false),
          );

  return {
    upsertRefs: (refs) =>
      withTransaction(
        Effect.forEach(
          Arr.chunksOf(refs, batchSize),
          (chunk) =>
            encodeRefs(chunk).pipe(
              Effect.flatMap((values) =>
                run("repos.upsertRefs", (db) =>
                  db
                    .insert(repos)
                    .values([...values])
                    .onConflictDoUpdate({
                      target: repos.id,
                      set: { owner: excluded(repos.owner), name: excluded(repos.name), nodeId: excluded(repos.nodeId) },
                      setWhere: sql`(${repos.owner}, ${repos.name}, ${repos.nodeId}) is distinct from (${excluded(repos.owner)}, ${excluded(repos.name)}, ${excluded(repos.nodeId)})`,
                    }),
                ),
              ),
            ),
          { discard: true },
        ),
      ),
    pendingEnrichment: (ids) =>
      run("repos.pendingEnrichment", (db) =>
        db
          .select({ id: repos.id })
          .from(repos)
          .where(sql`${repos.id} = any(${sql.param([...ids])}::bigint[]) and ${needsEnrichment}`),
      ).pipe(
        Effect.flatMap(decodeIds("repos.pendingEnrichment")),
        Effect.map((rows) => {
          const pending = new Set<number>(rows.map((row) => row.id));
          return ids.filter((id) => pending.has(id));
        }),
      ),
    saveFacts: (facts) =>
      encodeFacts(facts).pipe(
        Effect.flatMap((values) => {
          const { id: _, ...changes } = values;
          return run("repos.saveFacts", (db) =>
            db
              .insert(repos)
              .values(values)
              .onConflictDoUpdate({ target: repos.id, set: changes })
              .returning({ pending: needsEnrichment }),
          );
        }),
        Effect.flatMap(decodePending("repos.saveFacts")),
        Effect.map((rows) => ({ pending: rows.some((row) => row.pending) })),
      ),
    saveCounts: ({ id, stars, forks }) => {
      const counts = { stars, forks, refreshedAt: sql`now()` };
      return run("repos.saveCounts", (db) =>
        db
          .insert(repoMetrics)
          .values({ repoId: id, ...counts })
          .onConflictDoUpdate({ target: repoMetrics.repoId, set: counts }),
      );
    },
    saveSummary: (summary) =>
      encodeSummary(summary).pipe(
        Effect.flatMap(({ id, readmeOid, ...values }) =>
          run("repos.saveSummary", (db) =>
            db
              .update(repos)
              .set({ ...values, summaryReadmeOid: readmeOid, embedding: null, embeddingModel: null })
              .where(and(eq(repos.id, id), sql`${repos.readmeOid} is not distinct from ${readmeOid}`))
              .returning({ id: repos.id }),
          ),
        ),
        Effect.flatMap(applied("repos.saveSummary", summary.id)),
      ),
    saveEmbedding: (input) =>
      requireModel(configuredModel, input.embedding).pipe(
        Effect.flatMap((vector) =>
          run("repos.saveEmbedding", (db) =>
            db
              .update(repos)
              .set({ embedding: [...vector], embeddingModel: configuredModel })
              .where(
                and(
                  eq(repos.id, input.id),
                  sql`${repos.summary} is not distinct from ${input.summary}`,
                  sql`${repos.summaryReadmeOid} is not distinct from ${input.readmeOid}`,
                  sql`${repos.readmeOid} is not distinct from ${input.readmeOid}`,
                ),
              )
              .returning({ id: repos.id }),
          ),
        ),
        Effect.flatMap(applied("repos.saveEmbedding", input.id)),
      ),
    get: (id) =>
      run("repos.get", (db) => db.select(repoColumns).from(repos).where(eq(repos.id, id))).pipe(
        Effect.flatMap(decodeRepos("repos.get")),
        Effect.map(Arr.head),
      ),
    require: (id) =>
      run("repos.require", (db) => db.select(repoColumns).from(repos).where(eq(repos.id, id))).pipe(
        Effect.flatMap(decodeRepos("repos.require")),
        Effect.flatMap((rows) =>
          Effect.fromOption(Arr.head(rows)).pipe(Effect.mapError(() => new RepoNotFound({ repoId: id }))),
        ),
      ),
    getMany: (ids) =>
      run("repos.getMany", (db) =>
        db
          .select({ ...repoColumns, pending: needsEnrichment })
          .from(repos)
          .where(sql`${repos.id} = any(${sql.param([...ids])}::bigint[])`),
      ).pipe(Effect.flatMap(decodeStored("repos.getMany"))),
  } satisfies Queries;
});
