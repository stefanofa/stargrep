import { Login, ObjectId, RepoId, RepoName } from "@stargrep/github/schemas";
import { eq, getColumns, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { type Embedding, EmbeddingModelId, type EmbeddingModelMismatch, requireModel } from "../embedding.ts";
import { type DbQueryFailed, type DbRowInvalid, RepoNotFound } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { excluded, NullableTime, rowsDecoder, writeEncoder } from "../rows.ts";
import { repos } from "../schema.ts";

const RepoRow = createSelectSchema(repos, {
  id: RepoId,
  owner: Login,
  name: RepoName,
  topics: Schema.Array(Schema.String),
  createdAt: NullableTime,
  pushedAt: NullableTime,
  readmeOid: Schema.NullOr(ObjectId),
  keywords: Schema.Array(Schema.String),
  embeddingModel: Schema.NullOr(EmbeddingModelId),
});

export const Repo = Schema.Struct(Struct.omit(RepoRow.fields, ["embedding", "search"]));
export type Repo = typeof Repo.Type;

const { embedding: _embedding, search: _search, ...columns } = getColumns(repos);
export const repoColumns = columns;

export type RepoRef = Pick<Repo, "id" | "owner" | "name">;

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
  ]),
);
export type RepoFacts = typeof RepoFacts.Type;

const RepoSummary = Schema.Struct({
  ...Struct.pick(Repo.fields, ["id", "readmeOid", "keywords"]),
  summary: Schema.String,
  kind: Schema.String,
});
export type RepoSummary = typeof RepoSummary.Type;

export interface RepoEmbedding {
  readonly id: RepoId;
  readonly embedding: Embedding;
}

export interface Queries {
  readonly upsertRefs: (refs: ReadonlyArray<RepoRef>) => Effect.Effect<void, DbQueryFailed>;
  readonly unenriched: (
    ids: ReadonlyArray<RepoId>,
  ) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
  readonly saveFacts: (facts: RepoFacts) => Effect.Effect<void, DbQueryFailed>;
  readonly saveSummary: (summary: RepoSummary) => Effect.Effect<void, DbQueryFailed | RepoNotFound>;
  readonly saveEmbedding: (
    input: RepoEmbedding,
  ) => Effect.Effect<void, DbQueryFailed | RepoNotFound | EmbeddingModelMismatch>;
  readonly get: (id: RepoId) => Effect.Effect<Option.Option<Repo>, DbQueryFailed | DbRowInvalid>;
}

const batchSize = 1000;
const decodeRepos = rowsDecoder(Repo);
const decodeIds = rowsDecoder(Schema.Struct({ id: RepoId }));
const encodeFacts = writeEncoder(RepoFacts);
const encodeSummary = writeEncoder(RepoSummary);

const requireUpdated =
  (id: RepoId) =>
  (rows: ReadonlyArray<unknown>): Effect.Effect<void, RepoNotFound> =>
    rows.length === 0 ? Effect.fail(new RepoNotFound({ repoId: id })) : Effect.void;

export const make = Effect.fn("Db.repos.make")(function* (configuredModel: EmbeddingModelId) {
  const { run, withTransaction } = yield* Postgres.Postgres;

  return {
    upsertRefs: (refs) =>
      withTransaction(
        Effect.forEach(
          Arr.chunksOf(refs, batchSize),
          (chunk) =>
            run("repos.upsertRefs", (db) =>
              db
                .insert(repos)
                .values([...chunk])
                .onConflictDoUpdate({
                  target: repos.id,
                  set: { owner: excluded(repos.owner), name: excluded(repos.name) },
                  setWhere: sql`(${repos.owner}, ${repos.name}) is distinct from (${excluded(repos.owner)}, ${excluded(repos.name)})`,
                }),
            ),
          { discard: true },
        ),
      ),
    unenriched: (ids) =>
      run("repos.unenriched", (db) =>
        db
          .select({ id: repos.id })
          .from(repos)
          .where(sql`${repos.id} = any(${sql.param([...ids])}::bigint[]) and ${repos.summary} is null`),
      ).pipe(
        Effect.flatMap(decodeIds("repos.unenriched")),
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
            db.insert(repos).values(values).onConflictDoUpdate({ target: repos.id, set: changes }),
          );
        }),
      ),
    saveSummary: (summary) =>
      encodeSummary(summary).pipe(
        Effect.flatMap(({ id, ...values }) =>
          run("repos.saveSummary", (db) =>
            db
              .update(repos)
              .set({ ...values, embedding: null, embeddingModel: null })
              .where(eq(repos.id, id))
              .returning({ id: repos.id }),
          ),
        ),
        Effect.flatMap(requireUpdated(summary.id)),
      ),
    saveEmbedding: (input) =>
      requireModel(configuredModel, input.embedding).pipe(
        Effect.flatMap((vector) =>
          run("repos.saveEmbedding", (db) =>
            db
              .update(repos)
              .set({ embedding: [...vector], embeddingModel: configuredModel })
              .where(eq(repos.id, input.id))
              .returning({ id: repos.id }),
          ),
        ),
        Effect.flatMap(requireUpdated(input.id)),
      ),
    get: (id) =>
      run("repos.get", (db) => db.select(repoColumns).from(repos).where(eq(repos.id, id))).pipe(
        Effect.flatMap(decodeRepos("repos.get")),
        Effect.map(Arr.head),
      ),
  } satisfies Queries;
});
