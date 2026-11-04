// @effect-diagnostics anyUnknownInErrorContext:off cryptoRandomUUID:off effectFnOpportunity:off
// Throwaway spike: effect-postgres on @effect/sql-pg against pg + node-postgres, both through Hyperdrive.
import { PgClient } from "@effect/sql-pg";
import * as NodePostgres from "@stargrep/db/node-postgres";
import * as Postgres from "@stargrep/db/postgres";
import { eq, getTableName, sql } from "drizzle-orm";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import pg from "pg";

type Driver = "effect" | "effect-noprepare" | "pg";
const drivers: ReadonlyArray<Driver> = ["effect", "effect-noprepare", "pg"];
const poolMax = 4;

const randomName = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const spikeTable = (name: string) => pgTable(name, { id: integer().primaryKey(), v: text().notNull() });
type SpikeTable = ReturnType<typeof spikeTable>;

// A plain pg client for setup, teardown, and pg_stat_activity, so those never count against a driver.
const adminClient = (connectionString: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const client = new pg.Client({ connectionString });
      client.on("error", () => {});
      await client.connect();
      return client;
    }),
    (client) => Effect.promise(() => client.end()).pipe(Effect.ignore),
  );

const withSpikeTable = <A, E, R>(
  connectionString: string,
  use: (table: SpikeTable, admin: pg.Client) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const admin = yield* adminClient(connectionString);
    const name = randomName("spike_tx");
    yield* Effect.promise(() => admin.query(`create table ${name} (id int primary key, v text not null)`));
    return yield* use(spikeTable(name), admin).pipe(
      Effect.ensuring(Effect.promise(() => admin.query(`drop table if exists ${name}`)).pipe(Effect.ignore)),
    );
  });

const effectLayer = (connectionString: string, prepare: boolean) =>
  PgClient.layer({ url: Redacted.make(connectionString), maxConnections: poolMax, prepare });

const pgPostgres = (connectionString: string) =>
  NodePostgres.acquirePool(connectionString, poolMax).pipe(
    Effect.map((pool) => Postgres.make(NodePostgres.driver(pool))),
  );

// Walks error -> reason -> cause and keeps what identifies a failure.
const chain = (error: unknown, depth = 0): Array<Record<string, unknown>> => {
  if (depth > 6 || error === null || typeof error !== "object") return [];
  if (Cause.isCause(error)) return chain(Cause.squash(error), depth + 1);
  const e = error as Record<string, unknown>;
  const entry = {
    tag: e._tag ?? (e.constructor as { name?: string } | undefined)?.name,
    code: typeof e.code === "string" ? e.code : undefined,
    sqlState: typeof e.sqlState === "string" ? e.sqlState : undefined,
    reason: typeof e.reason === "string" ? e.reason : undefined,
    message: typeof e.message === "string" ? e.message.slice(0, 200) : undefined,
  };
  return [entry, ...chain(typeof e.reason === "object" ? e.reason : e.cause, depth + 1)];
};

const sqlStateOf = (error: unknown) => {
  for (const entry of chain(error)) {
    const value = entry.sqlState ?? entry.code;
    if (typeof value === "string" && /^[0-9A-Z]{5}$/.test(value)) return value;
  }
  return null;
};

const failureKey = (cause: Cause.Cause<unknown>) => {
  const squashed = Cause.squash(cause);
  const links = chain(squashed);
  return `${links.map((link) => link.tag).join(">")} sqlstate=${sqlStateOf(squashed) ?? "none"}`;
};

const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
};

// (a) Transactions: a write plus a read, `count` of them with `concurrency` in flight on a pool of four.
const runTransactions = (connectionString: string, driver: Driver, count: number, concurrency: number) =>
  withSpikeTable(connectionString, (table, admin) =>
    Effect.gen(function* () {
      const failures = new Map<string, number>();
      const record = (cause: Cause.Cause<unknown>) =>
        Effect.sync(() => {
          const key = failureKey(cause);
          failures.set(key, (failures.get(key) ?? 0) + 1);
        });
      const started = performance.now();
      if (driver === "pg") {
        const postgres = yield* pgPostgres(connectionString);
        yield* Effect.forEach(
          Array.from({ length: count }, (_, i) => i),
          (i) =>
            postgres
              .withTransaction(
                Effect.gen(function* () {
                  yield* postgres.run("transaction", (db) => db.insert(table).values({ id: i, v: `row ${i}` }));
                  yield* postgres.run("transaction", (db) => db.select().from(table).where(eq(table.id, i)));
                }),
              )
              .pipe(Effect.catchCause(record)),
          { concurrency, discard: true },
        );
      } else {
        yield* Effect.gen(function* () {
          const db = yield* PgDrizzle.makeWithDefaults();
          yield* Effect.forEach(
            Array.from({ length: count }, (_, i) => i),
            (i) =>
              db
                .transaction((tx) =>
                  Effect.gen(function* () {
                    yield* tx.insert(table).values({ id: i, v: `row ${i}` });
                    yield* tx.select().from(table).where(eq(table.id, i));
                  }),
                )
                .pipe(Effect.catchCause(record)),
            { concurrency, discard: true },
          );
        }).pipe(Effect.provide(effectLayer(connectionString, driver === "effect")));
      }
      const ms = Math.round(performance.now() - started);
      const committed = yield* Effect.promise(() =>
        admin.query(`select count(*)::int as n from ${getTableName(table)}`),
      );
      const failed = [...failures.values()].reduce((a, b) => a + b, 0);
      return {
        driver,
        count,
        concurrency,
        poolMax,
        failed,
        committed: committed.rows[0].n,
        ms,
        failures: Object.fromEntries(failures),
      };
    }),
  );

// (b) Cancellation: pg_sleep(5) in a fiber interrupted after 200 ms, then pg_stat_activity until the backend goes idle.
type CancelMode = "effect" | "effect-tx" | "pg";
const runCancel = (connectionString: string, mode: CancelMode) =>
  Effect.gen(function* () {
    const admin = yield* adminClient(connectionString);
    const tag = randomName("spike_cancel");
    const statement = `select pg_sleep(5), '${tag}' as tag`;
    const active = Effect.promise(() =>
      admin
        .query<{ pid: number; state: string; wait_event: string | null }>(
          "select pid, state, wait_event from pg_stat_activity where query like $1 and state = 'active' and pid <> pg_backend_pid()",
          [`%${tag}%`],
        )
        .then((result) => result.rows),
    );

    const observe = (query: Effect.Effect<unknown, unknown>, warm: Effect.Effect<unknown, unknown>) =>
      Effect.gen(function* () {
        yield* warm;
        const fiber = yield* Effect.forkChild(query);
        yield* Effect.sleep("200 millis");
        const before = yield* active;
        const t0 = performance.now();
        const interrupting = yield* Effect.forkChild(
          Fiber.interrupt(fiber).pipe(Effect.map(() => Math.round(performance.now() - t0))),
        );
        let goneAfterMs: number | null = null;
        const samples: Array<[number, number]> = [];
        while (performance.now() - t0 < 7000) {
          const rows = yield* active;
          const at = Math.round(performance.now() - t0);
          samples.push([at, rows.length]);
          if (rows.length === 0) {
            goneAfterMs = at;
            break;
          }
          yield* Effect.sleep("50 millis");
        }
        const interruptReturnedMs = yield* Fiber.join(interrupting);
        return {
          mode,
          activeBeforeInterrupt: before,
          interruptReturnedMs,
          goneAfterMs,
          samples: samples.slice(0, 12),
          sampleCount: samples.length,
        };
      });

    if (mode === "pg") {
      const postgres = yield* pgPostgres(connectionString);
      return yield* observe(
        postgres.run("transaction", (db) => db.execute(sql.raw(statement))),
        postgres.run("transaction", (db) => db.execute(sql`select 1`)),
      );
    }
    return yield* Effect.gen(function* () {
      const db = yield* PgDrizzle.makeWithDefaults();
      const client = yield* PgClient.PgClient;
      const sleep = db.execute(sql.raw(statement));
      return yield* observe(mode === "effect-tx" ? client.withTransaction(sleep) : sleep, db.execute(sql`select 1`));
    }).pipe(Effect.provide(effectLayer(connectionString, true)));
  });

// (c) Latency: a select and one transaction per driver, interleaved with a rotating order.
const runLatency = (connectionString: string, rounds: number) =>
  withSpikeTable(connectionString, (table) =>
    Effect.gen(function* () {
      const postgres = yield* pgPostgres(connectionString);
      const effectDb = (prepare: boolean) =>
        Layer.build(Layer.fresh(effectLayer(connectionString, prepare))).pipe(
          Effect.flatMap((context) => Effect.provide(PgDrizzle.makeWithDefaults(), context)),
        );
      const prepared = yield* effectDb(true);
      const unprepared = yield* effectDb(false);
      let nextId = 0;
      const ops: Record<
        Driver,
        { select: Effect.Effect<unknown, unknown>; tx: () => Effect.Effect<unknown, unknown> }
      > = {
        pg: {
          select: postgres.run("transaction", (db) => db.execute(sql`select 1 as one`)),
          tx: () => {
            const id = nextId++;
            return postgres.withTransaction(
              Effect.gen(function* () {
                yield* postgres.run("transaction", (db) => db.insert(table).values({ id, v: `row ${id}` }));
                yield* postgres.run("transaction", (db) => db.select().from(table).where(eq(table.id, id)));
              }),
            );
          },
        },
        effect: { select: prepared.execute(sql`select 1 as one`), tx: () => effectTx(prepared, table, nextId++) },
        "effect-noprepare": {
          select: unprepared.execute(sql`select 1 as one`),
          tx: () => effectTx(unprepared, table, nextId++),
        },
      };
      const timed = (effect: Effect.Effect<unknown, unknown>) =>
        Effect.gen(function* () {
          const t0 = performance.now();
          yield* effect;
          return performance.now() - t0;
        });
      const first: Partial<Record<Driver, number>> = {};
      for (const driver of drivers) first[driver] = Math.round(yield* timed(ops[driver].select));
      const samples = Object.fromEntries(
        drivers.map((d) => [d, { select: [] as Array<number>, tx: [] as Array<number> }]),
      ) as Record<Driver, { select: Array<number>; tx: Array<number> }>;
      for (let round = 0; round < rounds; round++) {
        const order = drivers.map((_, i) => drivers[(i + round) % drivers.length] as Driver);
        for (const driver of order) samples[driver].select.push(yield* timed(ops[driver].select));
        for (const driver of order) samples[driver].tx.push(yield* timed(ops[driver].tx()));
      }
      const summary = Object.fromEntries(
        drivers.map((d) => [
          d,
          {
            firstQueryIncludingConnectMs: first[d],
            selectP50: percentile(samples[d].select, 50),
            selectP95: percentile(samples[d].select, 95),
            txP50: percentile(samples[d].tx, 50),
            txP95: percentile(samples[d].tx, 95),
          },
        ]),
      );
      return { rounds, summary, raw: samples };
    }),
  );

const effectTx = (db: PgDrizzle.EffectPgDatabase & { $client: PgClient.PgClient }, table: SpikeTable, id: number) =>
  db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.insert(table).values({ id, v: `row ${id}` });
      yield* tx.select().from(table).where(eq(table.id, id));
    }),
  );

// (d) Errors: SQLSTATE, a dropped connection, and whether params leak into errors and logs.
const secret = "spike-secret-param-7f3a";
const describeCause = (cause: Cause.Cause<unknown>) => {
  const squashed = Cause.squash(cause);
  const pretty = Cause.pretty(cause);
  let json = "";
  try {
    json = JSON.stringify(squashed);
  } catch {
    json = "<unserializable>";
  }
  return {
    sqlState: sqlStateOf(squashed),
    chain: chain(squashed),
    secretInPretty: pretty.includes(secret),
    secretInJson: json.includes(secret),
    secretInMessage: String((squashed as { message?: unknown }).message ?? "").includes(secret),
    prettyHead: pretty.slice(0, 400),
  };
};
const failureOf = (effect: Effect.Effect<unknown, unknown>) =>
  effect.pipe(
    Effect.matchCause({
      onSuccess: () => ({ failed: false as const }),
      onFailure: (cause) => ({ failed: true as const, ...describeCause(cause) }),
    }),
  );

const runErrors = (connectionString: string) =>
  withSpikeTable(connectionString, (table, admin) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => admin.query(`insert into ${getTableName(table)} (id, v) values (1, 'seed')`));
      const terminate = (pid: number) => Effect.promise(() => admin.query("select pg_terminate_backend($1)", [pid]));
      const duplicate = { id: 1, v: secret };

      const effectResults = yield* Effect.gen(function* () {
        const plain = yield* PgDrizzle.makeWithDefaults();
        const withParams = yield* PgDrizzle.makeWithDefaults({ paramsInErrors: true });
        const client = yield* PgClient.PgClient;
        return {
          uniqueDefault: yield* failureOf(plain.insert(table).values(duplicate)),
          uniqueParamsInErrors: yield* failureOf(withParams.insert(table).values(duplicate)),
          uniqueInTransaction: yield* failureOf(plain.transaction((tx) => tx.insert(table).values(duplicate))),
          droppedInTransaction: yield* failureOf(
            client.withTransaction(
              Effect.gen(function* () {
                const rows = yield* plain.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
                yield* terminate((rows.rows[0] as { pid: number }).pid);
                yield* Effect.sleep("200 millis");
                yield* plain.execute(sql`select 1`);
              }),
            ),
          ),
          afterDrop: yield* failureOf(plain.execute(sql`select 1`)),
        };
      }).pipe(Effect.provide(effectLayer(connectionString, true)));

      const postgres = yield* pgPostgres(connectionString);
      const pgResults = {
        uniqueDefault: yield* failureOf(postgres.run("transaction", (db) => db.insert(table).values(duplicate))),
        droppedInTransaction: yield* failureOf(
          postgres.withTransaction(
            Effect.gen(function* () {
              const result = yield* postgres.run("transaction", (db) =>
                db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`),
              );
              yield* terminate(((result as { rows: Array<{ pid: number }> }).rows[0] as { pid: number }).pid);
              yield* Effect.sleep("200 millis");
              yield* postgres.run("transaction", (db) => db.execute(sql`select 1`));
            }),
          ),
        ),
        afterDrop: yield* failureOf(postgres.run("transaction", (db) => db.execute(sql`select 1`))),
      };
      return { effect: effectResults, pg: pgResults };
    }),
  );

// Proof for (a): one client connection reuses named statements; record which server backend served each.
const runPrepared = (connectionString: string, count: number) =>
  Effect.gen(function* () {
    const client = yield* PgClient.PgClient;
    const outside: Array<number> = [];
    const inside: Array<number> = [];
    const failures = new Map<string, number>();
    const record = (cause: Cause.Cause<unknown>) =>
      Effect.sync(() => {
        const key = failureKey(cause);
        failures.set(key, (failures.get(key) ?? 0) + 1);
      });
    for (let i = 0; i < count; i++) {
      yield* client.unsafe<{ pid: number }>("select pg_backend_pid() as pid, $1::int as n", [i]).pipe(
        Effect.tap((rows) => Effect.sync(() => outside.push(rows[0]?.pid ?? -1))),
        Effect.catchCause(record),
      );
      yield* client
        .withTransaction(client.unsafe<{ pid: number }>("select pg_backend_pid() as pid, $1::int as m", [i]))
        .pipe(
          Effect.tap((rows) => Effect.sync(() => inside.push(rows[0]?.pid ?? -1))),
          Effect.catchCause(record),
        );
    }
    const prepared = yield* client
      .unsafe<{ name: string; statement: string }>("select name, statement from pg_prepared_statements")
      .pipe(Effect.orElseSucceed(() => []));
    return {
      count,
      failures: Object.fromEntries(failures),
      distinctBackendsOutside: new Set(outside).size,
      distinctBackendsInTransactions: new Set(inside).size,
      outsidePids: outside.slice(0, 10),
      insidePids: inside.slice(0, 10),
      preparedOnFinalBackend: prepared.map((row) => `${row.name}: ${row.statement.slice(0, 60)}`),
    };
  }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(connectionString), maxConnections: 1, prepare: true })));

const intParam = (url: URL, name: string, fallback: number, max: number) => {
  const value = Number(url.searchParams.get(name) ?? fallback);
  return Number.isInteger(value) && value > 0 && value <= max ? value : fallback;
};

const respond = (work: Effect.Effect<unknown, unknown, Scope.Scope>) =>
  work.pipe(
    Effect.scoped,
    Effect.matchCauseEffect({
      onSuccess: (body) => HttpServerResponse.json(body),
      onFailure: (cause) => HttpServerResponse.json({ error: describeCause(cause) }, { status: 500 }),
    }),
  );

// Returns undefined for a path the spike does not own.
export const spikeRoute = (method: string, url: URL, connectionString: string, placement: string) => {
  if (method !== "POST" || !url.pathname.startsWith("/spike/")) return undefined;
  const tagged = <A extends object>(effect: Effect.Effect<A, unknown, Scope.Scope>) =>
    Effect.map(effect, (body) => ({ placement, ...body }));
  switch (url.pathname) {
    case "/spike/tx": {
      const driver = url.searchParams.get("driver") as Driver;
      if (!drivers.includes(driver)) return Effect.succeed(HttpServerResponse.empty({ status: 400 }));
      return respond(
        tagged(
          runTransactions(
            connectionString,
            driver,
            intParam(url, "count", 60, 400),
            intParam(url, "concurrency", 8, 64),
          ),
        ),
      );
    }
    case "/spike/cancel": {
      const mode = url.searchParams.get("mode") as CancelMode;
      if (!["effect", "effect-tx", "pg"].includes(mode))
        return Effect.succeed(HttpServerResponse.empty({ status: 400 }));
      return respond(tagged(runCancel(connectionString, mode)));
    }
    case "/spike/latency":
      return respond(tagged(runLatency(connectionString, intParam(url, "rounds", 30, 100))));
    case "/spike/errors":
      return respond(tagged(runErrors(connectionString)));
    case "/spike/prepared":
      return respond(tagged(runPrepared(connectionString, intParam(url, "count", 40, 200))));
    default:
      return Effect.succeed(HttpServerResponse.empty({ status: 404 }));
  }
};
