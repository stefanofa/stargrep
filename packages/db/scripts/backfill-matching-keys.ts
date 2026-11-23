import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import pg from "pg";
import { ignoreError } from "../src/node-postgres.ts";

// Writes every repo's keys into repo_matching_keys, for a database that held repos before the migration
// 20261123163925_matching_keys added the triggers that keep the table. Each batch inserts the next repos by ID and skips
// any a trigger already wrote. A trigger writes in the statement that changes an input, so a row it wrote is never
// older than the keys a batch read, and a batch that reads keys a trigger is about to change waits on that trigger's row
// and then skips it. A rerun writes only what is missing, so a run that stops can start again from the beginning.
// Workers fill ranges of IDs at once, and repo IDs bunch up, so the IDs are cut into many more ranges than workers.
const batch = 1000;
const workers = Number(process.env.WORKERS ?? 4);

// Postgres aborts one side of a deadlock or a serialization failure so the other can commit. The batch then rolls back
// whole, so it runs again from the same ID.
const lostRace = (error: unknown): error is pg.DatabaseError & { readonly code: string } =>
  error instanceof pg.DatabaseError && (error.code === "40P01" || error.code === "40001");

class BatchLostRace extends Schema.TaggedError<BatchLostRace, { readonly brand: unique symbol }>()("BatchLostRace", {
  after: Schema.Finite,
  sqlState: Schema.String,
}) {
  override get message(): string {
    return `The batch after repo ${this.after} lost a race (${this.sqlState})`;
  }
}

const connect = (url: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const connected = new pg.Client({ connectionString: url });
      connected.on("error", ignoreError);
      await connected.connect();
      await connected.query("set statement_timeout = '60s'");
      return connected;
    }),
    (connected) => Effect.promise(() => connected.end()),
  );

// Writes the keys of the repos with IDs above after and at most through, and returns the last ID it read.
const writeBatch = async (client: pg.Client, after: number, through: number) => {
  const { rows } = await client.query<{ last: string | null; read: string; written: string }>(
    `with next as (
       select id from repos where id > $1 and id <= $2 order by id limit $3
     ), written as (
       insert into repo_matching_keys (repo_id, keys)
       select k.repo_id, k.keys from knowledge_matching_keys(array(select id from next)) as k
       on conflict (repo_id) do nothing
       returning repo_id
     )
     select (select max(id) from next) as last, (select count(*) from next) as read, (select count(*) from written) as written`,
    [after, through, batch],
  );
  const row = rows[0];
  return { last: row?.last == null ? null : Number(row.last), read: Number(row?.read), written: Number(row?.written) };
};

const totals = { read: 0, written: 0 };

const writeRange = Effect.fn("writeRange")(function* (url: string, from: number, through: number) {
  const client = yield* connect(url);
  let after = from;
  for (;;) {
    const done = yield* Effect.promise(() => writeBatch(client, after, through)).pipe(
      Effect.catchDefect((defect) =>
        lostRace(defect) ? Effect.fail(new BatchLostRace({ after, sqlState: defect.code })) : Effect.die(defect),
      ),
      Effect.tapError((error) => Console.log(error.message)),
      Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 8 }),
    );
    if (done.last === null) return;
    after = done.last;
    const before = totals.read;
    totals.read += done.read;
    totals.written += done.written;
    if (Math.floor(totals.read / 50_000) > Math.floor(before / 50_000))
      yield* Console.log(`${totals.read} repos read, ${totals.written} rows written`);
  }
}, Effect.scoped);

const program = Effect.gen(function* () {
  const url = process.env.DATABASE_URL;
  if (url === undefined) return yield* Effect.die(new Error("Set DATABASE_URL to the database to backfill"));
  const bounds = yield* Effect.scoped(
    Effect.flatMap(connect(url), (client) =>
      Effect.promise(() =>
        client.query<{ low: string | null; high: string | null }>(
          "select min(id) - 1 as low, max(id) as high from repos",
        ),
      ),
    ),
  );
  const low = Number(bounds.rows[0]?.low ?? 0);
  const high = Number(bounds.rows[0]?.high ?? 0);
  const ranges = workers * 32;
  const step = Math.max(1, Math.ceil((high - low) / ranges));
  const started = performance.now();
  yield* Effect.forEach(
    Array.from({ length: ranges }, (_, index) => low + index * step),
    (from) => writeRange(url, from, Math.min(high, from + step)),
    { concurrency: workers, discard: true },
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  yield* Console.log(`Done in ${seconds} s: ${totals.read} repos read, ${totals.written} rows written`);
});

Effect.runPromise(program);
