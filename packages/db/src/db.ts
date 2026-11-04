import { drizzle } from "drizzle-orm/node-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import pg from "pg";
import type { EmbeddingModelId } from "./embedding.ts";
import type { DbQueryFailed } from "./errors.ts";
import * as NodePostgres from "./node-postgres.ts";
import * as Postgres from "./postgres.ts";
import * as Accounts from "./queries/accounts.ts";
import * as Repos from "./queries/repos.ts";
import * as Search from "./queries/search.ts";
import * as Settings from "./queries/settings.ts";
import * as Stars from "./queries/stars.ts";
import * as Usage from "./queries/usage.ts";

export type { Account, AccountFacts, OwnedRepoStars, StarSync } from "./queries/accounts.ts";
export type { Repo, RepoEmbedding, RepoFacts, RepoRef, RepoSummary, StoredRepo } from "./queries/repos.ts";
export type {
  HybridSearch,
  MetricBound,
  MetricRanking,
  SearchFilters,
  SearchHit,
  SearchMetric,
  SearchScope,
} from "./queries/search.ts";
export { MetricFamily, MetricVariant, noFilters } from "./queries/search.ts";
export type { SnapshotChanges, Star, StarEvent, StarredRepo, StarsSnapshot, StarsUpsert } from "./queries/stars.ts";
export type { UsageCall, UsageCounts, UsageDay } from "./queries/usage.ts";

export class Db extends Context.Service<
  Db,
  {
    readonly accounts: Accounts.Queries;
    readonly repos: Repos.Queries;
    readonly stars: Stars.Queries;
    readonly search: Search.Queries;
    readonly usage: Usage.Queries;
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
}

export interface NodePostgresOptions extends Options {
  readonly connectionString: Redacted.Redacted<string>;
}

export const layer = (options: Options) =>
  Layer.mergeAll(
    Layer.effect(
      Db,
      Effect.gen(function* () {
        const embeddingModel = yield* Settings.adopt(options.embeddingModel);
        return Db.of({
          accounts: yield* Accounts.make,
          repos: yield* Repos.make(embeddingModel),
          stars: yield* Stars.make,
          search: yield* Search.make(embeddingModel),
          usage: yield* Usage.make,
        });
      }),
    ),
    Layer.effect(
      Transactions,
      Effect.gen(function* () {
        const { withTransaction } = yield* Postgres.Postgres;
        return Transactions.of({ withTransaction });
      }),
    ),
  );

const nodePostgres = (connectionString: Redacted.Redacted<string>) =>
  Layer.effect(
    Postgres.Postgres,
    NodePostgres.acquirePool(Redacted.value(connectionString)).pipe(
      Effect.map((pool) =>
        Postgres.make({
          database: drizzle({ client: pool }),
          connect: async () => {
            const client = await pool.connect();
            // The pool listens for errors only on idle clients, and a transaction holds this one between statements.
            client.on("error", NodePostgres.ignoreError);
            return {
              database: drizzle({ client }),
              query: (statement) => client.query(statement),
              release: (broken) => {
                client.off("error", NodePostgres.ignoreError);
                client.release(broken);
              },
            };
          },
          isDatabaseError: (error) => error instanceof pg.DatabaseError,
          isConnectionError: NodePostgres.isConnectionError,
          exclusive: (effect) => effect,
        }),
      ),
    ),
  );

export const layerNodePostgres = (options: NodePostgresOptions) =>
  layer(options).pipe(Layer.provide(nodePostgres(options.connectionString)));
