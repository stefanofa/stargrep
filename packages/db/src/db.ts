import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import type { DbQueryFailed } from "./errors.ts";
import type { EmbeddingModel } from "./ids.ts";
import * as Memory from "./memory.ts";
import * as Postgres from "./postgres.ts";
import * as Accounts from "./queries/accounts.ts";
import * as Repos from "./queries/repos.ts";
import * as Search from "./queries/search.ts";
import * as Stars from "./queries/stars.ts";
import * as Usage from "./queries/usage.ts";

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
  readonly embeddingModel: EmbeddingModel;
}

export interface PostgresOptions extends Options {
  readonly connectionString: Redacted.Redacted<string>;
}

export const layerNodePostgres = (options: PostgresOptions) =>
  Layer.mergeAll(
    Layer.effect(
      Db,
      Effect.gen(function* () {
        return Db.of({
          accounts: yield* Accounts.postgres,
          repos: yield* Repos.postgres(options.embeddingModel),
          stars: yield* Stars.postgres,
          search: yield* Search.postgres(options.embeddingModel),
          usage: yield* Usage.postgres,
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
  ).pipe(Layer.provide(Postgres.layer(options.connectionString)));

export const layerMemory = (options: Options) =>
  Layer.mergeAll(
    Layer.effect(
      Db,
      Effect.gen(function* () {
        return Db.of({
          accounts: yield* Accounts.memory,
          repos: yield* Repos.memory(options.embeddingModel),
          stars: yield* Stars.memory,
          search: yield* Search.memory(options.embeddingModel),
          usage: yield* Usage.memory,
        });
      }),
    ),
    Layer.effect(
      Transactions,
      Effect.gen(function* () {
        const { withTransaction } = yield* Memory.MemoryStore;
        return Transactions.of({ withTransaction });
      }),
    ),
  ).pipe(Layer.provide(Memory.layer));
