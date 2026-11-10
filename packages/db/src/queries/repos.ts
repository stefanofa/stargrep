import { Repo as GitHubRepo, Login, ObjectId, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import { InputHash } from "@stargrep/knowledge/ids";
import { inputHash } from "@stargrep/knowledge/input-hash";
import { KindId } from "@stargrep/knowledge/registry";
import { and, asc, eq, getColumns, gt, isNotNull, type SQL, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import * as Digest from "effect/crypto/Digest";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Struct from "effect/Struct";
import { type Embedding, EmbeddingModelId, type EmbeddingModelMismatch, requireModel } from "../embedding.ts";
import { type DbQueryFailed, type DbRowInvalid, RepoNotFound } from "../errors.ts";
import { inIdOrder, lockedRepoIds } from "../lock-order.ts";
import * as Postgres from "../postgres.ts";
import { excluded, NullableTime, requireRow, rowsDecoder, timeParam, writeEncoder } from "../rows.ts";
import {
  accountType,
  iconPlate,
  iconSource,
  pendingEnrichment,
  repoMetrics,
  repos,
  retryableEnrichment,
  summaryDue,
} from "../schema.ts";

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
  enrichRetryAt: NullableTime,
  iconCheckedAt: NullableTime,
  inputHash: Schema.NullOr(InputHash),
  summaryInputHash: Schema.NullOr(InputHash),
});

export const IconSource = Schema.Literals(iconSource.enumValues);
export type IconSource = typeof IconSource.Type;

export const IconPlate = Schema.Literals(iconPlate.enumValues);
export type IconPlate = typeof IconPlate.Type;

export const OwnerType = Schema.Literals(accountType.enumValues);
export type OwnerType = typeof OwnerType.Type;

export const maxIconSize = 128;

export const RepoIcon = Schema.Struct({
  key: Schema.String,
  source: IconSource,
  plate: IconPlate,
  size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxIconSize })),
});
export type RepoIcon = typeof RepoIcon.Type;

// Columns a Repo leaves out: the vector, the full-text column, the retry state, the recipe that made the summary, and
// the knowledge columns, which only queries/knowledge/ reads and writes.
const internalColumns = [
  "embedding",
  "search",
  "enrichFailures",
  "enrichRetryAt",
  "summaryRecipe",
  "embeddingStale",
  "inputHash",
  "summaryInputHash",
  "receiptId",
  "goneAt",
  "kinds",
  "statuses",
  "writtenIn",
  "runsOn",
  "forLanguages",
  "forPlatforms",
  "builtWithLanguages",
  "builtWithPlatforms",
  "licensed",
  "altLanguages",
  "altPlatforms",
  "replacedByLanguages",
  "replacedByPlatforms",
] as const;

// kind is the repo's primary kind atom, which projection keeps first in kinds.
const rowFields = { ...Struct.omit(RepoRow.fields, internalColumns), kind: Schema.NullOr(KindId) };
const iconColumns = ["iconKey", "iconSource", "iconPlate", "iconSize"] as const;

interface IconColumns {
  readonly iconKey: string | null;
  readonly iconSource: IconSource | null;
  readonly iconPlate: IconPlate | null;
  readonly iconSize: number | null;
}

// repos_icon_complete keeps the four icon columns all set or all null, so they decode to one optional icon.
const iconOf = ({ iconKey, iconSource, iconPlate, iconSize }: IconColumns): RepoIcon | null =>
  iconKey === null || iconSource === null || iconPlate === null || iconSize === null
    ? null
    : { key: iconKey, source: iconSource, plate: iconPlate, size: iconSize };

const iconColumnsOf = (icon: RepoIcon | null): IconColumns => ({
  iconKey: icon?.key ?? null,
  iconSource: icon?.source ?? null,
  iconPlate: icon?.plate ?? null,
  iconSize: icon?.size ?? null,
});

const RepoColumns = Schema.Struct(rowFields);
const RepoFields = Schema.Struct({ ...Struct.omit(rowFields, iconColumns), icon: Schema.NullOr(RepoIcon) });

export const Repo = RepoColumns.pipe(
  Schema.decodeTo(
    Schema.toType(RepoFields),
    SchemaTransformation.transform({
      decode: ({ iconKey, iconSource, iconPlate, iconSize, ...rest }) => ({
        ...rest,
        icon: iconOf({ iconKey, iconSource, iconPlate, iconSize }),
      }),
      encode: ({ icon, ...rest }) => ({ ...rest, ...iconColumnsOf(icon) }),
    }),
  ),
);
export type Repo = typeof Repo.Type;

export const repoColumns = {
  ...Struct.omit(getColumns(repos), internalColumns),
  kind: sql<KindId | null>`(${repos.kinds})[1]::text`,
};

const RepoRef = GitHubRepo;
export type RepoRef = typeof RepoRef.Type;

// The facts saveFacts writes. An insert into repos names its columns, because a bare insert(repos) names every column
// the schema has and fails while a migration that drops one runs ahead of the Workers deploy.
const factColumns = [
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
  "ownerType",
  "ownerAvatarUrl",
] as const;
const RepoFacts = Schema.Struct(Struct.pick(rowFields, factColumns));
export type RepoFacts = typeof RepoFacts.Type;

export interface RepoCounts {
  readonly id: RepoId;
  readonly stars: number;
  readonly forks: number;
}

export interface RepoEmbedding {
  readonly id: RepoId;
  readonly owner: Repo["owner"];
  readonly name: Repo["name"];
  readonly embedding: Embedding;
  readonly summary: string;
  readonly keywords: ReadonlyArray<string>;
  readonly description: string | null;
  readonly readmeOid: ObjectId | null;
}

export interface IconCheck {
  readonly id: RepoId;
  readonly icon: RepoIcon | null;
}

export interface RepoOwner {
  readonly id: RepoId;
  readonly ownerType: OwnerType;
  readonly ownerAvatarUrl: string;
}

const DueIcon = Schema.Struct({ id: RepoId, nodeId: RepoNodeId });
export type DueIcon = typeof DueIcon.Type;

const enrichFields = Struct.pick(RepoRow.fields, [
  "enrichFailures",
  "enrichRetryAt",
  "summaryRecipe",
  "summaryInputHash",
]);

const StoredRepo = Schema.Struct({ ...rowFields, ...enrichFields, pending: Schema.Boolean }).pipe(
  Schema.decodeTo(
    Schema.toType(Schema.Struct({ ...RepoFields.fields, ...enrichFields, pending: Schema.Boolean })),
    SchemaTransformation.transform({
      decode: ({ iconKey, iconSource, iconPlate, iconSize, ...rest }) => ({
        ...rest,
        icon: iconOf({ iconKey, iconSource, iconPlate, iconSize }),
      }),
      encode: ({ icon, ...rest }) => ({ ...rest, ...iconColumnsOf(icon) }),
    }),
  ),
);
export type StoredRepo = typeof StoredRepo.Type;

export interface EnrichFailures {
  readonly ids: ReadonlyArray<RepoId>;
  readonly at: DateTime.Utc;
  /** The wait after each failure, in order. A failure past the last delay leaves no retry time. */
  readonly retryDelays: ReadonlyArray<Duration.Duration>;
}

export interface SweepQuery {
  readonly now: DateTime.Utc;
  readonly limit: number;
}

// An enrichment attempt's hold on repos before its paid summary call. enrich_retry_at is the time before which no paid
// attempt may start, so a lease is a retry time in the future, and until also names the lease, so the attempt can
// settle only its own.
export interface Lease {
  readonly ids: ReadonlyArray<RepoId>;
  readonly now: DateTime.Utc;
  readonly until: DateTime.Utc;
}

// How an attempt ends a lease whose paid call failed. A counted failure adds one to enrich_failures and turns the lease
// into that failure's backoff in the same statement, and any other failure gives the lease back.
export interface LeaseFailures {
  readonly until: DateTime.Utc;
  readonly failures: ReadonlyArray<{ readonly id: RepoId; readonly counted: boolean }>;
  readonly at: DateTime.Utc;
  /** The wait after each failure, in order. A failure past the last delay leaves no retry time. */
  readonly retryDelays: ReadonlyArray<Duration.Duration>;
}

export interface SavedFacts {
  readonly pending: boolean;
  // The hash of the prompt inputs these facts make, which an answer to that prompt must carry to be saved.
  readonly inputHash: InputHash;
}

export interface Queries {
  readonly upsertRefs: (refs: ReadonlyArray<RepoRef>) => Effect.Effect<void, DbQueryFailed>;
  readonly pendingEnrichment: (
    ids: ReadonlyArray<RepoId>,
  ) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
  readonly saveFacts: (facts: RepoFacts) => Effect.Effect<SavedFacts, DbQueryFailed | DbRowInvalid>;
  readonly saveCounts: (counts: RepoCounts) => Effect.Effect<void, DbQueryFailed>;
  readonly saveEmbedding: (
    input: RepoEmbedding,
  ) => Effect.Effect<boolean, DbQueryFailed | RepoNotFound | EmbeddingModelMismatch>;
  readonly saveIcon: (check: IconCheck) => Effect.Effect<void, DbQueryFailed>;
  readonly saveOwners: (owners: ReadonlyArray<RepoOwner>) => Effect.Effect<void, DbQueryFailed>;
  readonly dueIcons: (page: {
    readonly after: number;
    readonly limit: number;
    readonly checkedBefore: DateTime.Utc;
    readonly keyVersion: string;
  }) => Effect.Effect<ReadonlyArray<DueIcon>, DbQueryFailed | DbRowInvalid>;
  readonly get: (id: RepoId) => Effect.Effect<Option.Option<Repo>, DbQueryFailed | DbRowInvalid>;
  readonly require: (id: RepoId) => Effect.Effect<Repo, DbQueryFailed | DbRowInvalid | RepoNotFound>;
  readonly getMany: (
    ids: ReadonlyArray<RepoId>,
  ) => Effect.Effect<ReadonlyArray<StoredRepo>, DbQueryFailed | DbRowInvalid>;
  readonly recordEnrichFailures: (failures: EnrichFailures) => Effect.Effect<void, DbQueryFailed>;
  // Leases the repos whose summary is due and that no other attempt holds, and returns them. A repo due only for its
  // embedding is never leased, so no attempt pays for a summary another attempt has already saved.
  readonly lease: (lease: Lease) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
  // Settles failed paid calls on the repos this lease still holds, in one statement, so no other attempt can lease a
  // repo between its failure and its count.
  readonly settleFailures: (settled: LeaseFailures) => Effect.Effect<void, DbQueryFailed>;
  readonly sweepable: (query: SweepQuery) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
}

const batchSize = 1000;
const decodeRepos = rowsDecoder(Repo);
const decodeIds = rowsDecoder(Schema.Struct({ id: RepoId }));
const decodeStored = rowsDecoder(StoredRepo);
const decodePending = rowsDecoder(Schema.Struct({ pending: Schema.Boolean }));
const decodeDue = rowsDecoder(DueIcon);

const needsEnrichment = pendingEnrichment(repos);
const encodeRefs = writeEncoder(Schema.Array(RepoRef));
const encodeFacts = writeEncoder(RepoFacts);

// The retry time after one more failure. The array index past the last delay reads null, so a capped repo has none.
const retryAt = (at: DateTime.Utc, delays: ReadonlyArray<Duration.Duration>): SQL =>
  sql`${timeParam(at)} + (${sql.param(delays.map(Duration.toMillis))}::float8[])[${repos.enrichFailures} + 1] * interval '1 millisecond'`;

const repoFound = (id: RepoId) => requireRow(() => new RepoNotFound({ repoId: id }));

export const make = Effect.fn("Db.repos.make")(function* (configuredModel: EmbeddingModelId) {
  const { run, withTransaction } = yield* Postgres.Postgres;
  const digest = yield* Digest.Digest;

  const hashOf = (facts: RepoFacts) =>
    inputHash({
      readmeOid: facts.readmeOid,
      fullName: `${facts.owner}/${facts.name}`,
      description: facts.description,
      topics: facts.topics,
      language: facts.language,
    }).pipe(Effect.provideService(Digest.Digest, digest));

  const applied =
    (operation: "repos.saveEmbedding", id: RepoId) =>
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
          Arr.chunksOf(inIdOrder(refs), batchSize),
          (chunk) =>
            encodeRefs(chunk).pipe(
              Effect.flatMap((values) =>
                run("repos.upsertRefs", (db) =>
                  db
                    .insert(repos, "id", "nodeId", "owner", "name")
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
    // input_hash names the prompt inputs these facts make, so an answer to older facts can be told apart.
    saveFacts: (facts) =>
      Effect.all([encodeFacts(facts), hashOf(facts)]).pipe(
        Effect.flatMap(([encoded, hash]) => {
          const values = { ...encoded, inputHash: hash };
          const { id: _, ...changes } = values;
          return run("repos.saveFacts", (db) =>
            db
              .insert(repos, ...factColumns, "inputHash")
              .values(values)
              .onConflictDoUpdate({ target: repos.id, set: changes })
              .returning({ pending: needsEnrichment }),
          ).pipe(
            Effect.flatMap(decodePending("repos.saveFacts")),
            Effect.map((rows) => ({ pending: rows.some((row) => row.pending), inputHash: hash })),
          );
        }),
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
    saveEmbedding: (input) =>
      requireModel(configuredModel, input.embedding).pipe(
        Effect.flatMap((vector) =>
          run("repos.saveEmbedding", (db) =>
            db
              .update(repos)
              .set({
                embedding: [...vector],
                embeddingModel: configuredModel,
                embeddingStale: false,
                enrichFailures: 0,
                enrichRetryAt: null,
              })
              .where(
                and(
                  eq(repos.id, input.id),
                  sql`${repos.owner} is not distinct from ${input.owner}`,
                  sql`${repos.name} is not distinct from ${input.name}`,
                  sql`${repos.summary} is not distinct from ${input.summary}`,
                  eq(repos.keywords, [...input.keywords]),
                  sql`${repos.description} is not distinct from ${input.description}`,
                  sql`${repos.summaryReadmeOid} is not distinct from ${input.readmeOid}`,
                  sql`${repos.readmeOid} is not distinct from ${input.readmeOid}`,
                ),
              )
              .returning({ id: repos.id }),
          ),
        ),
        Effect.flatMap(applied("repos.saveEmbedding", input.id)),
      ),
    saveIcon: ({ id, icon }) =>
      run("repos.saveIcon", (db) =>
        db
          .update(repos)
          .set({ ...iconColumnsOf(icon), iconCheckedAt: sql`now()` })
          .where(eq(repos.id, id)),
      ),
    saveOwners: (owners) => {
      const sorted = inIdOrder(owners);
      return sorted.length === 0
        ? Effect.void
        : run("repos.saveOwners", (db) =>
            db
              .update(repos)
              .set({ ownerType: sql`owners.owner_type::account_type`, ownerAvatarUrl: sql`owners.owner_avatar_url` })
              .from(
                sql`(select * from unnest(${sql.param(sorted.map((owner) => owner.id))}::bigint[], ${sql.param(sorted.map((owner) => owner.ownerType))}::text[], ${sql.param(sorted.map((owner) => owner.ownerAvatarUrl))}::text[]) as owners(id, owner_type, owner_avatar_url)) as owners`,
              )
              .where(sql`${repos.id} = owners.id`),
          );
    },
    dueIcons: ({ after, limit, checkedBefore, keyVersion }) =>
      run("repos.dueIcons", (db) =>
        db
          .select({ id: repos.id, nodeId: repos.nodeId })
          .from(repos)
          .where(
            and(
              sql`(${repos.iconCheckedAt} is null or ${repos.iconCheckedAt} < ${timeParam(checkedBefore)} or ${repos.iconKey} not like ${`${keyVersion}/%`})`,
              isNotNull(repos.nodeId),
              gt(repos.id, after),
            ),
          )
          .orderBy(asc(repos.id))
          .limit(limit),
      ).pipe(Effect.flatMap(decodeDue("repos.dueIcons"))),
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
          .select({
            ...repoColumns,
            pending: needsEnrichment,
            enrichFailures: repos.enrichFailures,
            enrichRetryAt: repos.enrichRetryAt,
            summaryRecipe: repos.summaryRecipe,
            summaryInputHash: repos.summaryInputHash,
          })
          .from(repos)
          .where(sql`${repos.id} = any(${sql.param([...ids])}::bigint[])`),
      ).pipe(Effect.flatMap(decodeStored("repos.getMany"))),
    // A copy of an attempt already counted, such as a second message for the same repo, finds the retry time in
    // the future and changes nothing.
    recordEnrichFailures: ({ ids, at, retryDelays }) =>
      Arr.isReadonlyArrayEmpty(ids)
        ? Effect.void
        : run("repos.recordEnrichFailures", (db) =>
            db
              .update(repos)
              .set({
                enrichFailures: sql`${repos.enrichFailures} + 1`,
                enrichRetryAt: retryAt(at, retryDelays),
              })
              .where(
                sql`${repos.id} in (${lockedRepoIds(ids)}) and ${needsEnrichment} and (${repos.enrichRetryAt} is null or ${repos.enrichRetryAt} <= ${timeParam(at)})`,
              ),
          ),
    lease: ({ ids, now, until }) =>
      Arr.isReadonlyArrayEmpty(ids)
        ? Effect.succeed([])
        : run("repos.lease", (db) =>
            db
              .update(repos)
              .set({ enrichRetryAt: sql`${timeParam(until)}` })
              .where(
                sql`${repos.id} in (${lockedRepoIds(ids)}) and ${summaryDue(repos)} and (${repos.enrichRetryAt} is null or ${repos.enrichRetryAt} <= ${timeParam(now)})`,
              )
              .returning({ id: repos.id }),
          ).pipe(
            Effect.flatMap(decodeIds("repos.lease")),
            Effect.map((rows) => {
              const leased = new Set<number>(rows.map((row) => row.id));
              return ids.filter((id) => leased.has(id));
            }),
          ),
    settleFailures: ({ until, failures, at, retryDelays }) => {
      const sorted = inIdOrder(failures);
      const counts = sql`settled.counted and ${needsEnrichment}`;
      return sorted.length === 0
        ? Effect.void
        : run("repos.settleFailures", (db) =>
            db
              .update(repos)
              .set({
                enrichFailures: sql`${repos.enrichFailures} + case when ${counts} then 1 else 0 end`,
                enrichRetryAt: sql`case when ${counts} then ${retryAt(at, retryDelays)} end`,
              })
              .from(
                sql`unnest(${sql.param(sorted.map((failure) => failure.id))}::bigint[], ${sql.param(sorted.map((failure) => failure.counted))}::boolean[]) as settled (id, counted)`,
              )
              .where(
                sql`${repos.id} = settled.id and ${repos.id} in (${lockedRepoIds(sorted.map((failure) => failure.id))}) and ${repos.enrichRetryAt} = ${timeParam(until)}`,
              ),
          );
    },
    sweepable: ({ now, limit }) =>
      run("repos.sweepable", (db) =>
        db
          .select({ id: repos.id })
          .from(repos)
          .where(
            sql`${retryableEnrichment(repos)} and (${repos.enrichRetryAt} is null or ${repos.enrichRetryAt} <= ${timeParam(now)})`,
          )
          .orderBy(sql`${repos.enrichRetryAt} nulls last`, repos.id)
          .limit(limit),
      ).pipe(
        Effect.flatMap(decodeIds("repos.sweepable")),
        Effect.map((rows) => rows.map((row) => row.id)),
      ),
  } satisfies Queries;
});
