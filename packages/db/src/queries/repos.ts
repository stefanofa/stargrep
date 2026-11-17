import { summaryRecipe } from "@stargrep/ai/models";
import {
  Repo as GitHubRepo,
  ListedRepo,
  Login,
  ObjectId,
  RepoId,
  RepoName,
  RepoNodeId,
} from "@stargrep/github/schemas";
import { InputHash } from "@stargrep/knowledge/ids";
import { inputHash } from "@stargrep/knowledge/input-hash";
import { KindId } from "@stargrep/knowledge/registry";
import { and, asc, eq, getColumns, gt, isNotNull, type SQL, sql } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import * as Arr from "effect/Array";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
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
import { excluded, json, NullableTime, requireRow, rowsDecoder, timeParam, writeEncoder } from "../rows.ts";
import {
  accountType,
  enrichFailureCap,
  iconPlate,
  iconSource,
  metadataEmbeddingDue,
  pendingEnrichment,
  repoMetrics,
  repos,
  retryableEnrichment,
  summaryDue,
} from "../schema.ts";
import { sharedLock } from "./knowledge/lock.ts";

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

// Columns a Repo leaves out: the vector and the text it was made from, the full-text column, the retry state, the summary
// cap's mark, the recipe that made the summary, and the knowledge columns, which only queries/knowledge/ reads and writes.
const internalColumns = [
  "embedding",
  "embeddingSource",
  "search",
  "enrichFailures",
  "enrichRetryAt",
  "summaryDeferred",
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
export type { ListedRepo };

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

// The metadata a repo waiting for its summary is embedded from, as the row held it when read.
const RepoMetadata = Schema.Struct({
  id: RepoId,
  owner: Login,
  name: RepoName,
  description: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
});
export type RepoMetadata = typeof RepoMetadata.Type;

export interface MetadataEmbedding {
  readonly metadata: RepoMetadata;
  readonly embedding: Embedding;
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

// The repos the summary cap refused while this attempt held their lease, and when the cap has room again.
export interface Deferral {
  readonly ids: ReadonlyArray<RepoId>;
  readonly until: DateTime.Utc;
  readonly retryAt: DateTime.Utc;
}

const NamedRepo = Schema.Struct({ id: RepoId, owner: Login, name: RepoName });
export type NamedRepo = typeof NamedRepo.Type;

const SummaryCandidate = Schema.Struct({ ...NamedRepo.fields, stars: Schema.Int });
export type SummaryCandidate = typeof SummaryCandidate.Type;

// An enrichment attempt's hold on repos before its paid summary call. enrich_retry_at is the time before which no paid
// attempt may start, so a lease is a retry time in the future, and until also names the lease, so the attempt can
// settle only its own.
export interface Lease {
  readonly ids: ReadonlyArray<RepoId>;
  readonly now: DateTime.Utc;
  readonly until: DateTime.Utc;
}

// How an attempt ends a lease whose paid call failed. count adds one to enrich_failures and turns the lease into that
// failure's backoff in the same statement. cap puts the repo at the cap at once, for a failure that would repeat on
// every call, so the sweep never sends it again. release gives the lease back.
export type FailureSettlement = "count" | "cap" | "release";

export interface LeaseFailures {
  readonly until: DateTime.Utc;
  readonly failures: ReadonlyArray<{ readonly id: RepoId; readonly settled: FailureSettlement }>;
  readonly at: DateTime.Utc;
  /** The wait after each failure, in order. A failure past the last delay leaves no retry time. */
  readonly retryDelays: ReadonlyArray<Duration.Duration>;
}

// The prefill's facts for one chunk, with the batch lease each repo takes in the statement that saves them.
export interface LeasedFacts {
  readonly repos: ReadonlyArray<RepoFacts & RepoCounts & { readonly nodeId: RepoNodeId }>;
  readonly now: DateTime.Utc;
  readonly until: DateTime.Utc;
  // Leases a repo whose summary is current too, for a pilot that must ask repos the sweep already answered.
  readonly askCurrent: boolean;
}

// leased says this statement took the repo's lease, so its summary is due and no other attempt held it.
export interface FactsLease {
  readonly id: RepoId;
  readonly inputHash: InputHash;
  readonly leased: boolean;
}

export interface SavedFacts {
  readonly pending: boolean;
  // The hash of the prompt inputs these facts make, which an answer to that prompt must carry to be saved.
  readonly inputHash: InputHash;
}

export interface Queries {
  readonly upsertRefs: (refs: ReadonlyArray<RepoRef>) => Effect.Effect<void, DbQueryFailed>;
  // Saves the repos a star list shows. It inserts a new one with the list's metadata, follows a rename, and fills in the
  // metadata of a repo enrichment has not read yet, so a repo can be embedded from its metadata before its summary. It
  // also stores the list's star count for a repo with no metrics yet, which enrichment's facts later replace.
  readonly saveListed: (listed: ReadonlyArray<ListedRepo>) => Effect.Effect<void, DbQueryFailed>;
  readonly pendingEnrichment: (
    ids: ReadonlyArray<RepoId>,
  ) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
  readonly saveFacts: (facts: RepoFacts) => Effect.Effect<SavedFacts, DbQueryFailed | DbRowInvalid>;
  readonly saveCounts: (counts: RepoCounts) => Effect.Effect<void, DbQueryFailed>;
  // Saves a chunk's facts and takes the lease of every repo whose summary is due and that no other attempt holds, in
  // one statement, so no sweep or consumer can find one of them due before the batch holds it. Then saves the counts,
  // which need the rows. It takes the shared knowledge lock first, so the caller runs it in its own transaction.
  readonly saveFactsAndLease: (
    lease: LeasedFacts,
  ) => Effect.Effect<ReadonlyArray<FactsLease>, DbQueryFailed | DbRowInvalid>;
  // The repos that need no prefill: gone, or summarized under the current recipe. With askCurrent, gone, or listed by
  // a prefill manifest of the current recipe, so a pilot asks each repo once however current its summary is.
  readonly summarized: (
    ids: ReadonlyArray<RepoId>,
    askCurrent?: boolean,
  ) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid>;
  readonly saveEmbedding: (
    input: RepoEmbedding,
  ) => Effect.Effect<boolean, DbQueryFailed | RepoNotFound | EmbeddingModelMismatch>;
  // The metadata of each of these repos that is due an embedding of it, once each, in the order given.
  readonly metadataDue: (
    ids: ReadonlyArray<RepoId>,
  ) => Effect.Effect<ReadonlyArray<RepoMetadata>, DbQueryFailed | DbRowInvalid>;
  // Saves each embedding whose repo still waits for its summary, holds no summary embedding, and has the metadata it was
  // made from, and returns the repos it saved. It leaves the lease, the failures, and the summary cap's mark alone,
  // since the repo still waits for its summary.
  readonly saveMetadataEmbeddings: (
    embeddings: ReadonlyArray<MetadataEmbedding>,
  ) => Effect.Effect<ReadonlyArray<RepoId>, DbQueryFailed | DbRowInvalid | EmbeddingModelMismatch>;
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
  // Moves this attempt's lease on repos the summary cap refused to the time the cap has room again, counting no
  // failure, so the sweep sends them again then. It marks them deferred until they are read, so the library counts them
  // as queued.
  readonly defer: (deferral: Deferral) => Effect.Effect<void, DbQueryFailed>;
  // How many repos under the failure cap wait for a paid summary, leased or not.
  readonly summaryBacklog: Effect.Effect<number, DbQueryFailed | DbRowInvalid>;
  // The repos the sweep would send next that have no summary under the current recipe and that no attempt holds, in
  // the sweep's order, for a prefill run on a developer's machine. The prefill counts a repo summarized under the
  // current recipe as done, so a repo due only because its README or inputs moved is left to the sweep.
  readonly pendingSummaries: (
    query: SweepQuery,
  ) => Effect.Effect<ReadonlyArray<NamedRepo>, DbQueryFailed | DbRowInvalid>;
  // The repos among these that have no summary under the current recipe, are under the failure cap, and have at least
  // minStars GitHub stars by their metrics, for a prefill list. The prefill takes the rest from there.
  readonly summaryCandidates: (input: {
    readonly ids: ReadonlyArray<RepoId>;
    readonly minStars: number;
  }) => Effect.Effect<ReadonlyArray<SummaryCandidate>, DbQueryFailed | DbRowInvalid>;
}

const batchSize = 1000;
const decodeRepos = rowsDecoder(Repo);
const decodeIds = rowsDecoder(Schema.Struct({ id: RepoId }));
const decodeStored = rowsDecoder(StoredRepo);
const decodePending = rowsDecoder(Schema.Struct({ pending: Schema.Boolean }));
const decodeDue = rowsDecoder(DueIcon);
const decodeLeases = rowsDecoder(Schema.Struct({ id: RepoId, inputHash: InputHash, leased: Schema.Boolean }));
const decodeNamed = rowsDecoder(NamedRepo);
const decodeCandidates = rowsDecoder(SummaryCandidate);
const decodeCount = rowsDecoder(Schema.Struct({ count: Schema.Int }));
const decodeMetadata = rowsDecoder(RepoMetadata);

const needsEnrichment = pendingEnrichment(repos);
const encodeRefs = writeEncoder(Schema.Array(RepoRef));
const encodeListed = writeEncoder(Schema.Array(ListedRepo));
const encodeFacts = writeEncoder(RepoFacts);

// A repo the sweep may send now: due, under the failure cap, and held by no attempt or backoff.
const sweepableAt = (now: DateTime.Utc) =>
  sql`${retryableEnrichment(repos)} and (${repos.enrichRetryAt} is null or ${repos.enrichRetryAt} <= ${timeParam(now)})`;
const sweepOrder = [sql`${repos.enrichRetryAt} nulls last`, repos.id] as const;

// The retry time after one more failure. The array index past the last delay reads null, so a capped repo has none.
const retryAt = (at: DateTime.Utc, delays: ReadonlyArray<Duration.Duration>): SQL =>
  sql`${timeParam(at)} + (${sql.param(delays.map(Duration.toMillis))}::float8[])[${repos.enrichFailures} + 1] * interval '1 millisecond'`;

const repoFound = (id: RepoId) => requireRow(() => new RepoNotFound({ repoId: id }));

const topicSet = (topics: SQL) =>
  sql`(select coalesce(array_agg(topic order by topic), '{}'::text[]) from jsonb_array_elements_text(${topics}) topic)`;

// A write of a repo's metadata marks an embedding of it stale when the name, description, or topics it was made from
// change. The star list sorts a repo's topics and GraphQL does not, so their order alone changes nothing.
const metadataMoved = (written: { owner: SQL; name: SQL; description: SQL; topics: SQL }) =>
  sql`${repos.embeddingStale} or (${repos.embeddingSource} = 'metadata' and (${repos.owner}, ${repos.name}, ${repos.description}, ${topicSet(sql`${repos.topics}`)}) is distinct from (${written.owner}, ${written.name}, ${written.description}, ${topicSet(written.topics)}))`;

const factsMoved = metadataMoved({
  owner: excluded(repos.owner),
  name: excluded(repos.name),
  description: excluded(repos.description),
  topics: excluded(repos.topics),
});

// A star list's metadata fills in only a repo enrichment has not read, which saveFacts has never given an input hash.
const unlessRead = (column: typeof repos.description | typeof repos.topics | typeof repos.language) =>
  sql`case when ${repos.inputHash} is null then ${excluded(column)} else ${column} end`;

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
    saveListed: (listed) =>
      withTransaction(
        Effect.forEach(
          Arr.chunksOf(inIdOrder(listed), batchSize),
          (chunk) =>
            encodeListed(chunk).pipe(
              Effect.flatMap((values) =>
                run("repos.saveListed", (db) =>
                  db
                    .insert(repos, "id", "nodeId", "owner", "name", "description", "topics", "language")
                    .values(values.map(({ stars: _, ...repo }) => repo))
                    .onConflictDoUpdate({
                      target: repos.id,
                      set: {
                        owner: excluded(repos.owner),
                        name: excluded(repos.name),
                        nodeId: excluded(repos.nodeId),
                        description: unlessRead(repos.description),
                        topics: unlessRead(repos.topics),
                        language: unlessRead(repos.language),
                        embeddingStale: metadataMoved({
                          owner: excluded(repos.owner),
                          name: excluded(repos.name),
                          description: unlessRead(repos.description),
                          topics: unlessRead(repos.topics),
                        }),
                      },
                      setWhere: sql`(${repos.owner}, ${repos.name}, ${repos.nodeId}) is distinct from (${excluded(repos.owner)}, ${excluded(repos.name)}, ${excluded(repos.nodeId)}) or (${repos.inputHash} is null and (${repos.description}, ${repos.topics}, ${repos.language}) is distinct from (${excluded(repos.description)}, ${excluded(repos.topics)}, ${excluded(repos.language)}))`,
                    }),
                ),
              ),
              Effect.andThen(() => {
                const counted = chunk.flatMap((repo) =>
                  repo.stars === null ? [] : [{ repoId: repo.id, stars: repo.stars, refreshedAt: sql`now()` }],
                );
                return Arr.isReadonlyArrayNonEmpty(counted)
                  ? run("repos.saveListed", (db) => db.insert(repoMetrics).values(counted).onConflictDoNothing())
                  : Effect.void;
              }),
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
              .onConflictDoUpdate({ target: repos.id, set: { ...changes, embeddingStale: factsMoved } })
              .returning({ pending: needsEnrichment }),
          ).pipe(
            Effect.flatMap(decodePending("repos.saveFacts")),
            Effect.map((rows) => ({ pending: rows.some((row) => row.pending), inputHash: hash })),
          );
        }),
      ),
    saveFactsAndLease: Effect.fn("Db.repos.saveFactsAndLease")(function* ({
      repos: chunk,
      now,
      until,
      askCurrent,
    }: LeasedFacts) {
      const sorted = inIdOrder(chunk);
      // The summary is due for the facts this statement saves, so the README and input hash come from excluded.
      const dueOnSave = sql`(${repos.summary} is null or ${repos.summaryReadmeOid} is distinct from ${excluded(repos.readmeOid)} or ${repos.summaryRecipe} is distinct from ${sql.raw(String(summaryRecipe))} or ${repos.summaryInputHash} is distinct from ${excluded(repos.inputHash)}) and ${repos.goneAt} is null`;
      const free = sql`(${repos.enrichRetryAt} is null or ${repos.enrichRetryAt} <= ${timeParam(now)})`;
      const askable = sql`${repos.goneAt} is null`;
      const counts = sorted.map((repo) => ({
        repoId: repo.id,
        stars: repo.stars,
        forks: repo.forks,
        refreshedAt: sql`now()`,
      }));
      if (Arr.isReadonlyArrayEmpty(sorted)) return [];
      {
        const rows = yield* Effect.forEach(sorted, (repo) =>
          Effect.all([encodeFacts(repo), hashOf(repo)]).pipe(
            Effect.map(([encoded, hash]) => ({
              ...encoded,
              nodeId: repo.nodeId,
              inputHash: hash,
              enrichRetryAt: DateTime.toDateUtc(until),
            })),
          ),
        );
        // Shared first, as capture takes it: the facts update marks repo_facets rows stale, and a mint's
        // invalidation marks them too, in heap order, under the exclusive lock.
        yield* run("repos.saveFactsAndLease", (db) => db.execute(sharedLock));
        const leases = yield* run("repos.saveFactsAndLease", (db) =>
          db
            .insert(repos, ...factColumns, "nodeId", "inputHash", "enrichRetryAt")
            .values(rows)
            .onConflictDoUpdate({
              target: repos.id,
              set: {
                nodeId: excluded(repos.nodeId),
                owner: excluded(repos.owner),
                name: excluded(repos.name),
                description: excluded(repos.description),
                topics: excluded(repos.topics),
                language: excluded(repos.language),
                license: excluded(repos.license),
                homepage: excluded(repos.homepage),
                createdAt: excluded(repos.createdAt),
                pushedAt: excluded(repos.pushedAt),
                archived: excluded(repos.archived),
                readmeOid: excluded(repos.readmeOid),
                ownerType: excluded(repos.ownerType),
                ownerAvatarUrl: excluded(repos.ownerAvatarUrl),
                inputHash: excluded(repos.inputHash),
                embeddingStale: factsMoved,
                enrichRetryAt: sql`case when ${askCurrent ? askable : dueOnSave} and ${free} then ${excluded(repos.enrichRetryAt)} else ${repos.enrichRetryAt} end`,
              },
            })
            .returning({
              id: repos.id,
              inputHash: repos.inputHash,
              leased: sql<boolean>`${repos.enrichRetryAt} is not distinct from ${timeParam(until)}`,
            }),
        ).pipe(Effect.flatMap(decodeLeases("repos.saveFactsAndLease")));
        yield* run("repos.saveCounts", (db) =>
          db
            .insert(repoMetrics)
            .values(counts)
            .onConflictDoUpdate({
              target: repoMetrics.repoId,
              set: {
                stars: excluded(repoMetrics.stars),
                forks: excluded(repoMetrics.forks),
                refreshedAt: sql`now()`,
              },
            }),
        );
        return leases;
      }
    }),
    summarized: (ids, askCurrent = false) =>
      run("repos.summarized", (db) =>
        db
          .select({ id: repos.id })
          .from(repos)
          .where(
            askCurrent
              ? sql`${repos.id} = any(${sql.param([...ids])}::bigint[]) and (${repos.goneAt} is not null or exists (select 1 from extraction_batches b where b.recipe = ${sql.raw(String(summaryRecipe))} and ${repos.id} = any(b.repo_ids)))`
              : sql`${repos.id} = any(${sql.param([...ids])}::bigint[]) and (${repos.goneAt} is not null or (${repos.summary} is not null and ${repos.summaryRecipe} = ${sql.raw(String(summaryRecipe))}))`,
          ),
      ).pipe(
        Effect.flatMap(decodeIds("repos.summarized")),
        Effect.map((rows) => rows.map((row) => row.id)),
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
                embeddingSource: "summary",
                embeddingStale: false,
                enrichFailures: 0,
                enrichRetryAt: null,
                summaryDeferred: false,
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
    metadataDue: (ids) =>
      Arr.isReadonlyArrayEmpty(ids)
        ? Effect.succeed([])
        : run("repos.metadataDue", (db) =>
            db
              .select({
                id: repos.id,
                owner: repos.owner,
                name: repos.name,
                description: repos.description,
                topics: repos.topics,
              })
              .from(repos)
              .where(sql`${repos.id} = any(${sql.param([...ids])}::bigint[]) and ${metadataEmbeddingDue(repos)}`),
          ).pipe(
            Effect.flatMap(decodeMetadata("repos.metadataDue")),
            Effect.map((rows) => {
              const due = new Map<number, RepoMetadata>(rows.map((row) => [row.id, row]));
              return Arr.dedupe(ids).flatMap((id) => due.get(id) ?? []);
            }),
          ),
    saveMetadataEmbeddings: (embeddings) =>
      Effect.forEach(inIdOrder(embeddings.map((entry) => ({ ...entry, id: entry.metadata.id }))), (entry) =>
        Effect.map(requireModel(configuredModel, entry.embedding), (vector) => ({
          ...entry.metadata,
          embedding: `[${vector.join(",")}]`,
        })),
      ).pipe(
        Effect.flatMap((rows) =>
          Arr.isReadonlyArrayEmpty(rows)
            ? Effect.succeed([])
            : run("repos.saveMetadataEmbeddings", (db) =>
                db
                  .update(repos)
                  .set({
                    embedding: sql`saved.embedding::halfvec`,
                    embeddingModel: configuredModel,
                    embeddingSource: "metadata",
                    embeddingStale: false,
                  })
                  .from(
                    sql`jsonb_to_recordset(${json(rows)}) as saved (id bigint, owner text, name text, description text, topics jsonb, embedding text)`,
                  )
                  .where(
                    sql`${repos.id} = saved.id and ${repos.id} in (${lockedRepoIds(rows.map((row) => row.id))}) and ${summaryDue(repos)} and (${repos.embedding} is null or ${repos.embeddingSource} = 'metadata') and (${repos.owner}, ${repos.name}, ${repos.description}, ${repos.topics}) is not distinct from (saved.owner, saved.name, saved.description, saved.topics)`,
                  )
                  .returning({ id: repos.id }),
              ).pipe(
                Effect.flatMap(decodeIds("repos.saveMetadataEmbeddings")),
                Effect.map((saved) => saved.map((row) => row.id)),
              ),
        ),
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
      const counts = sql`settled.kind = 'count' and ${needsEnrichment}`;
      const caps = sql`settled.kind = 'cap' and ${needsEnrichment}`;
      return sorted.length === 0
        ? Effect.void
        : run("repos.settleFailures", (db) =>
            db
              .update(repos)
              .set({
                enrichFailures: sql`case when ${caps} then greatest(${repos.enrichFailures}, ${sql.raw(String(enrichFailureCap))}) when ${counts} then ${repos.enrichFailures} + 1 else ${repos.enrichFailures} end`,
                enrichRetryAt: sql`case when ${counts} then ${retryAt(at, retryDelays)} end`,
              })
              .from(
                sql`unnest(${sql.param(sorted.map((failure) => failure.id))}::bigint[], ${sql.param(sorted.map((failure) => failure.settled))}::text[]) as settled (id, kind)`,
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
          .where(sweepableAt(now))
          .orderBy(...sweepOrder)
          .limit(limit),
      ).pipe(
        Effect.flatMap(decodeIds("repos.sweepable")),
        Effect.map((rows) => rows.map((row) => row.id)),
      ),
    defer: ({ ids, until, retryAt: at }) =>
      Arr.isReadonlyArrayEmpty(ids)
        ? Effect.void
        : run("repos.defer", (db) =>
            db
              .update(repos)
              .set({ enrichRetryAt: sql`${timeParam(at)}`, summaryDeferred: true })
              .where(sql`${repos.id} in (${lockedRepoIds(ids)}) and ${repos.enrichRetryAt} = ${timeParam(until)}`),
          ),
    summaryBacklog: run("repos.summaryBacklog", (db) =>
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(repos)
        .where(sql`${retryableEnrichment(repos)} and ${summaryDue(repos)}`),
    ).pipe(
      Effect.flatMap(decodeCount("repos.summaryBacklog")),
      Effect.map((rows) => rows[0]?.count ?? 0),
    ),
    pendingSummaries: ({ now, limit }) =>
      run("repos.pendingSummaries", (db) =>
        db
          .select({ id: repos.id, owner: repos.owner, name: repos.name })
          .from(repos)
          .where(
            sql`${sweepableAt(now)} and (${repos.summary} is null or ${repos.summaryRecipe} is distinct from ${sql.raw(String(summaryRecipe))})`,
          )
          .orderBy(...sweepOrder)
          .limit(limit),
      ).pipe(Effect.flatMap(decodeNamed("repos.pendingSummaries"))),
    summaryCandidates: ({ ids, minStars }) =>
      run("repos.summaryCandidates", (db) =>
        db
          .select({ id: repos.id, owner: repos.owner, name: repos.name, stars: sql<number>`${repoMetrics.stars}` })
          .from(repos)
          .innerJoin(repoMetrics, eq(repoMetrics.repoId, repos.id))
          .where(
            sql`${repos.id} = any(${sql.param([...ids])}::bigint[]) and ${repoMetrics.stars} >= ${minStars} and ${retryableEnrichment(repos)} and (${repos.summary} is null or ${repos.summaryRecipe} is distinct from ${sql.raw(String(summaryRecipe))})`,
          ),
      ).pipe(Effect.flatMap(decodeCandidates("repos.summaryCandidates"))),
  } satisfies Queries;
});
