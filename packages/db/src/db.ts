import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import type { EmbeddingModelId } from "./embedding.ts";
import type { DbQueryFailed } from "./errors.ts";
import * as NodePostgres from "./node-postgres.ts";
import * as Postgres from "./postgres.ts";
import * as Accounts from "./queries/accounts.ts";
import * as Knowledge from "./queries/knowledge.ts";
import * as RateLines from "./queries/rate-lines.ts";
import * as Repos from "./queries/repos.ts";
import * as Search from "./queries/search.ts";
import * as Settings from "./queries/settings.ts";
import * as Stars from "./queries/stars.ts";
import * as SyncRequests from "./queries/sync-requests.ts";
import * as Usage from "./queries/usage.ts";

export type {
  Account,
  AccountClaim,
  AccountFacts,
  OwnedRepoStars,
  StarredCount,
  StarSync,
} from "./queries/accounts.ts";
export type {
  Answer,
  Captured,
  Decided,
  Decision,
  DecisionRow,
  Invalidation,
  KeptLegacy,
  Label,
  LegacyAnswer,
  LegacyContent,
  LegacyRepo,
  LockedRepo,
  MintClaim,
  Minted,
  Projected,
  Projection,
  Reach,
  ReceiptSource,
  StoredAtom,
  SubjectInfo,
  Variant,
  VocabularyChange,
} from "./queries/knowledge.ts";
export { noChange } from "./queries/knowledge.ts";
export type { Reservation, Reserved } from "./queries/rate-lines.ts";
export { CallerKey, LineKey } from "./queries/rate-lines.ts";
export type {
  DueIcon,
  EnrichFailures,
  IconCheck,
  Lease,
  LeaseFailures,
  Repo,
  RepoCounts,
  RepoEmbedding,
  RepoFacts,
  RepoOwner,
  RepoRef,
  SavedFacts,
  StoredRepo,
  SweepQuery,
} from "./queries/repos.ts";
export { IconPlate, IconSource, maxIconSize, OwnerType, RepoIcon } from "./queries/repos.ts";
export type {
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
export { MetricFamily, MetricVariant, noAtoms, noFilters } from "./queries/search.ts";
export type {
  EnrichmentProgress,
  LibraryEntry,
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
export type { UsageCall, UsageCounts, UsageDay } from "./queries/usage.ts";
export { enrichFailureCap } from "./schema.ts";

export class Db extends Context.Service<
  Db,
  {
    readonly accounts: Accounts.Queries;
    readonly repos: Repos.Queries;
    readonly stars: Stars.Queries;
    readonly search: Search.Queries;
    readonly syncRequests: SyncRequests.Queries;
    readonly rateLines: RateLines.Queries;
    readonly usage: Usage.Queries;
    readonly knowledge: Knowledge.Queries;
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
          stars: yield* Stars.make,
          search: yield* Search.make(embeddingModel),
          syncRequests: yield* SyncRequests.make,
          rateLines: yield* RateLines.make,
          usage: yield* Usage.make,
          knowledge: yield* Knowledge.make,
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
