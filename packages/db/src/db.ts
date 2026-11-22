import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import type { EmbeddingModelId } from "./embedding.ts";
import type { DbQueryFailed } from "./errors.ts";
import * as NodePostgres from "./node-postgres.ts";
import * as Postgres from "./postgres.ts";
import * as Accounts from "./queries/accounts.ts";
import * as Facets from "./queries/facets.ts";
import * as IconBackfill from "./queries/icon-backfill.ts";
import * as Knowledge from "./queries/knowledge/index.ts";
import * as MonthlyPicks from "./queries/monthly-picks.ts";
import * as People from "./queries/people.ts";
import * as RateLines from "./queries/rate-lines.ts";
import * as Repos from "./queries/repos.ts";
import * as Search from "./queries/search.ts";
import * as Settings from "./queries/settings.ts";
import * as Similar from "./queries/similar.ts";
import * as StarImports from "./queries/star-imports.ts";
import * as Stars from "./queries/stars.ts";
import * as SyncRequests from "./queries/sync-requests.ts";
import * as Topics from "./queries/topics.ts";
import * as Usage from "./queries/usage.ts";

export type {
  Account,
  AccountClaim,
  AccountFacts,
  OwnedRepoStars,
  StarredCount,
  StarSync,
} from "./queries/accounts.ts";
export type { FacetCount, HeldAtom, MatchingAtoms } from "./queries/facets.ts";
export type {
  Answer,
  BatchAdapter,
  BatchState,
  Captured,
  Decided,
  Decision,
  DecisionRow,
  FloorPage,
  Label,
  LockedRepo,
  Manifest,
  MintClaim,
  Minted,
  NewManifest,
  Projected,
  Projection,
  Reach,
  ReceiptSource,
  StoredAtom,
  SubjectInfo,
  Variant,
} from "./queries/knowledge/index.ts";
export type {
  Liked,
  PeoplePage,
  PeopleQuery,
  PeopleSort,
  Person,
  Refreshed,
  Stargazers,
} from "./queries/people.ts";
export { peopleRule } from "./queries/people.ts";
export type { Receipt, Reservation, Reserved } from "./queries/rate-lines.ts";
export { CallerKey, LineKey } from "./queries/rate-lines.ts";
export type {
  DueIcon,
  EnrichFailures,
  FactsLease,
  FailureSettlement,
  IconCheck,
  Lease,
  LeasedFacts,
  LeaseFailures,
  ListedRepo,
  MetadataEmbedding,
  Repo,
  RepoCounts,
  RepoEmbedding,
  RepoFacts,
  RepoMetadata,
  RepoOwner,
  RepoRef,
  SavedFacts,
  StoredRepo,
  SweepQuery,
} from "./queries/repos.ts";
export { IconPlate, IconSource, maxIconSize, OwnerType, RepoIcon } from "./queries/repos.ts";
export type {
  AcceptedKeys,
  AtomQuery,
  ClosedGroup,
  GroupMode,
  Hybrid,
  HybridSearch,
  MetricBound,
  MetricRanking,
  Resolution,
  SearchFilters,
  SearchHit,
  SearchMetric,
  SearchScope,
  StatedGroup,
  SubjectGroup,
} from "./queries/search.ts";
export { acceptedKeysTtl, MetricFamily, MetricVariant, noAtoms, noFilters } from "./queries/search.ts";
export type { SimilarQuery, SimilarRepo, SimilarRows } from "./queries/similar.ts";
export type {
  EnrichmentProgress,
  LibraryEntry,
  NewToYou,
  NewToYouRequest,
  SnapshotChanges,
  Star,
  StarEvent,
  StarredRepo,
  StarsPage,
  StarsPosition,
  StarsSnapshot,
  StarsUpsert,
} from "./queries/stars.ts";
export type { Settlement, SyncClaim, SyncRequest } from "./queries/sync-requests.ts";
export type {
  Refreshed as TopicsRefreshed,
  TopicCount,
  TopicPage,
  TopicPerson,
  TopicRepo,
  TopicsPage,
  TopicsQuery,
} from "./queries/topics.ts";
export { canonicalTopic, topicAliases, topicRule } from "./queries/topics.ts";
export type { UsageCall, UsageCounts, UsageDay } from "./queries/usage.ts";
export { enrichFailureCap, summaryPolicy } from "./schema.ts";

export class Db extends Context.Service<
  Db,
  {
    readonly accounts: Accounts.Queries;
    readonly repos: Repos.Queries;
    readonly stars: Stars.Queries;
    readonly search: Search.Queries;
    readonly similar: Similar.Queries;
    readonly syncRequests: SyncRequests.Queries;
    readonly rateLines: RateLines.Queries;
    readonly usage: Usage.Queries;
    readonly knowledge: Knowledge.Queries;
    readonly facets: Facets.Queries;
    readonly monthlyPicks: MonthlyPicks.Queries;
    readonly starImports: StarImports.Queries;
    readonly iconBackfill: IconBackfill.Queries;
    readonly people: People.Queries;
    readonly topics: Topics.Queries;
  }
>()("@stargrep/db/db") {}

export class Transactions extends Context.Service<
  Transactions,
  {
    readonly withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | DbQueryFailed, R>;
  }
>()("@stargrep/db/db/Transactions") {}

export interface Options {
  readonly embeddingModel: EmbeddingModelId;
  /** Skips the embedding_settings read once a build that shares this Ref has passed it. */
  readonly adopted?: Ref.Ref<boolean>;
  /** Shares the accepted label keys a build last read across builds. Each build keeps its own when this is left out. */
  readonly acceptedKeys?: Ref.Ref<Option.Option<Search.AcceptedKeys>>;
}

export interface NodePostgresOptions extends Options {
  readonly connectionString: Redacted.Redacted<string>;
  readonly maxConnections?: number;
}

const adopt = (options: Options) => {
  const { adopted } = options;
  const check = Settings.adopt(options.embeddingModel);
  if (adopted === undefined) return check;
  return Effect.flatMap(Ref.get(adopted), (done) =>
    done ? Effect.succeed(options.embeddingModel) : Effect.tap(check, () => Ref.set(adopted, true)),
  );
};

export const layer = (options: Options) =>
  Layer.mergeAll(
    Layer.effect(
      Db,
      Effect.gen(function* () {
        const embeddingModel = yield* adopt(options);
        return Db.of({
          accounts: yield* Accounts.make,
          repos: yield* Repos.make(embeddingModel),
          stars: yield* Stars.make(embeddingModel),
          search: yield* Search.make(
            embeddingModel,
            options.acceptedKeys ?? (yield* Ref.make(Option.none<Search.AcceptedKeys>())),
          ),
          similar: yield* Similar.make(embeddingModel),
          syncRequests: yield* SyncRequests.make,
          rateLines: yield* RateLines.make,
          usage: yield* Usage.make,
          knowledge: yield* Knowledge.make,
          facets: yield* Facets.make,
          monthlyPicks: yield* MonthlyPicks.make,
          starImports: yield* StarImports.make,
          iconBackfill: yield* IconBackfill.make,
          people: yield* People.make,
          topics: yield* Topics.make,
        });
      }),
    ).pipe(Layer.provide(Digest.layerWebCrypto)),
    Layer.effect(
      Transactions,
      Effect.gen(function* () {
        const { withTransaction } = yield* Postgres.Postgres;
        return Transactions.of({ withTransaction });
      }),
    ),
  );

const nodePostgres = (options: NodePostgresOptions) =>
  Layer.effect(
    Postgres.Postgres,
    NodePostgres.acquirePool(Redacted.value(options.connectionString), options.maxConnections).pipe(
      Effect.map((pool) => Postgres.make(NodePostgres.driver(pool))),
    ),
  );

export const layerNodePostgres = (options: NodePostgresOptions) =>
  layer(options).pipe(Layer.provide(nodePostgres(options)));
