import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { DbQueryFailed, type Operation } from "./errors.ts";

export type Database = PgAsyncDatabase<PgQueryResultHKT>;

export interface TransactionClient {
  readonly database: Database;
  readonly query: (statement: "begin" | "commit" | "rollback") => PromiseLike<unknown>;
  readonly release: (broken: boolean) => void;
}

export interface Driver {
  readonly database: Database;
  readonly connect: () => PromiseLike<TransactionClient>;
  readonly isDatabaseError: (error: unknown) => error is { readonly code?: string | undefined };
  // A lost connection the driver reports without a SQLSTATE or socket code.
  readonly isConnectionError: (error: unknown) => boolean;
  readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

const queryTimeout = "10 seconds";

const socketErrors = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

const reasonOf = (sqlState: string | null) =>
  sqlState === null || /^(08|28|53|57)/.test(sqlState)
    ? "transport"
    : sqlState.startsWith("23")
      ? "constraint"
      : "query";

const classify = (driver: Driver, operation: Operation, error: unknown): Option.Option<DbQueryFailed> => {
  if (driver.isDatabaseError(error)) {
    const sqlState = error.code ?? null;
    return Option.some(new DbQueryFailed({ operation, reason: reasonOf(sqlState), sqlState }));
  }
  if (
    driver.isConnectionError(error) ||
    (Predicate.hasProperty(error, "code") && Predicate.isString(error.code) && socketErrors.has(error.code))
  ) {
    return Option.some(new DbQueryFailed({ operation, reason: "transport", sqlState: null }));
  }
  return Predicate.hasProperty(error, "cause") ? classify(driver, operation, error.cause) : Option.none();
};

const CurrentTransaction = Context.Reference<Option.Option<Database>>("@stargrep/db/postgres/CurrentTransaction", {
  defaultValue: Option.none,
});

export class Postgres extends Context.Service<
  Postgres,
  {
    readonly run: <A>(operation: Operation, query: (db: Database) => PromiseLike<A>) => Effect.Effect<A, DbQueryFailed>;
    readonly withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | DbQueryFailed, R>;
  }
>()("@stargrep/db/postgres") {}

export const make = (driver: Driver) => {
  const attempt = <A>(operation: Operation, evaluate: () => PromiseLike<A>) =>
    Effect.promise(evaluate).pipe(
      Effect.catchDefect((defect) =>
        Option.match(classify(driver, operation, defect), {
          onNone: () => Effect.die(defect),
          onSome: Effect.fail,
        }),
      ),
      Effect.timeoutOrElse({
        duration: queryTimeout,
        orElse: () => Effect.fail(new DbQueryFailed({ operation, reason: "timeout", sqlState: null })),
      }),
    );

  const run = Effect.fnUntraced(
    function* <A>(operation: Operation, query: (db: Database) => PromiseLike<A>) {
      const transaction = yield* CurrentTransaction;
      return yield* Option.match(transaction, {
        onNone: () => driver.exclusive(attempt(operation, () => query(driver.database))),
        onSome: (database) => attempt(operation, () => query(database)),
      });
    },
    (effect, operation) => Effect.withSpan(effect, `Db.${operation}`),
  );

  const begin = attempt("transaction", driver.connect).pipe(
    Effect.tap((client) =>
      attempt("transaction", () => client.query("begin")).pipe(
        Effect.onError(() => Effect.sync(() => client.release(true))),
      ),
    ),
  );

  const finish = (client: TransactionClient, statement: "commit" | "rollback") =>
    attempt("transaction", () => client.query(statement)).pipe(
      Effect.onExit((exit) => Effect.sync(() => client.release(Exit.isFailure(exit)))),
    );

  const withTransaction = Effect.fn("Transactions.withTransaction")(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) {
    if (Option.isSome(yield* CurrentTransaction)) return yield* effect;
    return yield* driver.exclusive(
      Effect.acquireUseRelease(
        begin,
        (client) => Effect.provideService(effect, CurrentTransaction, Option.some(client.database)),
        (client, exit) =>
          Exit.isSuccess(exit) ? finish(client, "commit") : finish(client, "rollback").pipe(Effect.ignore),
      ),
    );
  });

  return Postgres.of({ run, withTransaction });
};
