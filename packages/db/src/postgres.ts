import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import pg from "pg";
import { DbQueryFailed, type Operation } from "./errors.ts";

type Database = NodePgDatabase;

const queryTimeout = "10 seconds";

const sqlStateOf = (error: unknown): string | null => {
  if (!Predicate.isObject(error)) return null;
  if (Predicate.hasProperty(error, "code") && Predicate.isString(error.code) && /^[0-9A-Z]{5}$/.test(error.code)) {
    return error.code;
  }
  return Predicate.hasProperty(error, "cause") ? sqlStateOf(error.cause) : null;
};

const queryFailed = (operation: Operation, error: unknown) => {
  const sqlState = sqlStateOf(error);
  const reason =
    sqlState === null || /^(08|28|53|57)/.test(sqlState)
      ? "transport"
      : sqlState.startsWith("23")
        ? "constraint"
        : "query";
  return new DbQueryFailed({ operation, reason, sqlState });
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

const attempt = <A>(operation: Operation, run: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => queryFailed(operation, error) }).pipe(
    Effect.timeoutOrElse({
      duration: queryTimeout,
      orElse: () => Effect.fail(new DbQueryFailed({ operation, reason: "timeout", sqlState: null })),
    }),
  );

const make = Effect.fn("Postgres.make")(function* (connectionString: Redacted.Redacted<string>) {
  const pool = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const pool = new pg.Pool({ connectionString: Redacted.value(connectionString) });
      // pg emits idle-client failures on the pool, and an unhandled emit ends the process.
      // The pool drops that client, and the next query reports its own error.
      pool.on("error", () => {});
      return pool;
    }),
    (pool) => Effect.promise(() => pool.end()),
  );
  const db = drizzle({ client: pool });

  const run = Effect.fnUntraced(
    function* <A>(operation: Operation, query: (db: Database) => PromiseLike<A>) {
      const transaction = yield* CurrentTransaction;
      return yield* attempt(operation, () => query(Option.getOrElse(transaction, () => db)));
    },
    (effect, operation) => Effect.withSpan(effect, `Db.${operation}`),
  );

  const begin = attempt("transaction", () => pool.connect()).pipe(
    Effect.tap((client) =>
      attempt("transaction", () => client.query("begin")).pipe(
        Effect.onError(() => Effect.sync(() => client.release(true))),
      ),
    ),
  );

  const finish = (client: pg.PoolClient, statement: "commit" | "rollback") =>
    attempt("transaction", () => client.query(statement)).pipe(
      Effect.onExit((exit) => Effect.sync(() => client.release(Exit.isFailure(exit)))),
    );

  const withTransaction = Effect.fn("Transactions.withTransaction")(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) {
    if (Option.isSome(yield* CurrentTransaction)) return yield* effect;
    return yield* Effect.acquireUseRelease(
      begin,
      (client) => Effect.provideService(effect, CurrentTransaction, Option.some(drizzle({ client }))),
      (client, exit) =>
        Exit.isSuccess(exit) ? finish(client, "commit") : finish(client, "rollback").pipe(Effect.ignore),
    );
  });

  return Postgres.of({ run, withTransaction });
});

export const layer = (connectionString: Redacted.Redacted<string>) => Layer.effect(Postgres, make(connectionString));
