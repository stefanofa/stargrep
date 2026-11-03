import { eq, getColumns, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { type Embedding, requireModel } from "../embedding.ts";
import { type DbQueryFailed, type DbRowInvalid, type EmbeddingModelMismatch, RepoNotFound } from "../errors.ts";
import { EmbeddingModel, Login, ObjectId, RepoId, RepoName } from "../ids.ts";
import * as Memory from "../memory.ts";
import * as Postgres from "../postgres.ts";
import { NullableTime, rowsDecoder } from "../rows.ts";
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
  embeddingModel: Schema.NullOr(EmbeddingModel),
});

export const Repo = Schema.Struct(Struct.omit(RepoRow.fields, ["embedding", "search"]));
export type Repo = typeof Repo.Type;

const { embedding: _embedding, search: _search, ...columns } = getColumns(repos);
export const repoColumns = columns;

export type RepoRef = Pick<Repo, "id" | "owner" | "name">;

export type RepoFacts = Pick<
  Repo,
  | "id"
  | "owner"
  | "name"
  | "description"
  | "topics"
  | "language"
  | "license"
  | "homepage"
  | "createdAt"
  | "pushedAt"
  | "archived"
>;

export interface RepoSummary {
  readonly id: RepoId;
  readonly readmeOid: ObjectId | null;
  readonly summary: string;
  readonly keywords: ReadonlyArray<string>;
  readonly kind: string;
}

export interface RepoEmbedding {
  readonly id: RepoId;
  readonly embedding: Embedding;
}

export type StoredRepo = Repo & { readonly embedding: ReadonlyArray<number> | null };

export interface Queries {
  readonly upsertRefs: (refs: ReadonlyArray<RepoRef>) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed>;
  readonly saveFacts: (facts: RepoFacts) => Effect.Effect<void, DbQueryFailed>;
  readonly saveSummary: (summary: RepoSummary) => Effect.Effect<void, DbQueryFailed | RepoNotFound>;
  readonly saveEmbedding: (
    input: RepoEmbedding,
  ) => Effect.Effect<void, DbQueryFailed | RepoNotFound | EmbeddingModelMismatch>;
  readonly get: (id: RepoId) => Effect.Effect<Option.Option<Repo>, DbQueryFailed | DbRowInvalid>;
}

const batchSize = 1000;
const decodeRepos = rowsDecoder(Repo);
const excluded = (column: string) => sql.raw(`excluded."${column}"`);
const toDate = (time: DateTime.Utc | null) => (time === null ? null : DateTime.toDateUtc(time));

const requireUpdated =
  (id: RepoId) =>
  (rows: ReadonlyArray<unknown>): Effect.Effect<void, RepoNotFound> =>
    rows.length === 0 ? Effect.fail(new RepoNotFound({ repoId: id })) : Effect.void;

export const postgres = Effect.fn("Db.repos.postgres")(function* (configuredModel: EmbeddingModel) {
  const { run } = yield* Postgres.Postgres;

  return {
    upsertRefs: (refs) =>
      Effect.forEach(Arr.chunksOf(refs, batchSize), (chunk) =>
        run("repos.upsertRefs", (db) =>
          db
            .insert(repos)
            .values([...chunk])
            .onConflictDoUpdate({
              target: repos.id,
              set: { owner: excluded("owner"), name: excluded("name") },
              setWhere: sql`(${repos.owner}, ${repos.name}) is distinct from (excluded."owner", excluded."name")`,
            })
            .returning({ id: repos.id, inserted: sql<boolean>`xmax = 0` }),
        ),
      ).pipe(
        Effect.map((results) => {
          const inserted = new Set(results.flat().flatMap((row) => (row.inserted ? [row.id] : [])));
          return refs.flatMap((ref) => (inserted.has(ref.id) ? [ref.id] : []));
        }),
      ),
    saveFacts: (facts) => {
      const values = {
        ...facts,
        topics: [...facts.topics],
        createdAt: toDate(facts.createdAt),
        pushedAt: toDate(facts.pushedAt),
      };
      const { id: _, ...changes } = values;
      return run("repos.saveFacts", (db) =>
        db.insert(repos).values(values).onConflictDoUpdate({ target: repos.id, set: changes }),
      );
    },
    saveSummary: (summary) =>
      run("repos.saveSummary", (db) =>
        db
          .update(repos)
          .set({
            readmeOid: summary.readmeOid,
            summary: summary.summary,
            keywords: [...summary.keywords],
            kind: summary.kind,
            embedding: null,
            embeddingModel: null,
          })
          .where(eq(repos.id, summary.id))
          .returning({ id: repos.id }),
      ).pipe(Effect.flatMap(requireUpdated(summary.id))),
    saveEmbedding: (input) =>
      requireModel(configuredModel, input.embedding).pipe(
        Effect.flatMap((vector) =>
          run("repos.saveEmbedding", (db) =>
            db
              .update(repos)
              .set({ embedding: [...vector], embeddingModel: input.embedding.model })
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

const emptyRepo = (ref: RepoRef): StoredRepo => ({
  ...ref,
  description: null,
  topics: [],
  language: null,
  license: null,
  homepage: null,
  kind: null,
  createdAt: null,
  pushedAt: null,
  archived: false,
  readmeOid: null,
  summary: null,
  keywords: [],
  embedding: null,
  embeddingModel: null,
});

export const memory = Effect.fn("Db.repos.memory")(function* (configuredModel: EmbeddingModel) {
  const { tables } = yield* Memory.MemoryStore;

  const update = (id: RepoId, change: (repo: StoredRepo) => StoredRepo) =>
    Effect.suspend(() => {
      const repo = tables.repos.get(id);
      if (repo === undefined) return Effect.fail(new RepoNotFound({ repoId: id }));
      tables.repos.set(id, change(repo));
      return Effect.void;
    });

  return {
    upsertRefs: (refs) =>
      Effect.sync(() =>
        refs.flatMap((ref) => {
          const existing = tables.repos.get(ref.id);
          tables.repos.set(ref.id, { ...(existing ?? emptyRepo(ref)), owner: ref.owner, name: ref.name });
          return existing === undefined ? [ref.id] : [];
        }),
      ),
    saveFacts: (facts) =>
      Effect.sync(() => {
        tables.repos.set(facts.id, { ...(tables.repos.get(facts.id) ?? emptyRepo(facts)), ...facts });
      }),
    saveSummary: (summary) =>
      update(summary.id, (repo) => ({ ...repo, ...summary, embedding: null, embeddingModel: null })),
    saveEmbedding: (input) =>
      requireModel(configuredModel, input.embedding).pipe(
        Effect.flatMap((vector) =>
          update(input.id, (repo) => ({ ...repo, embedding: vector, embeddingModel: input.embedding.model })),
        ),
      ),
    get: (id) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(tables.repos.get(id)).pipe(Option.map(({ embedding: _, ...repo }) => repo)),
      ),
  } satisfies Queries;
});
