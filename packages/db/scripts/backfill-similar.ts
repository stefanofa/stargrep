import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import pg from "pg";
import { ignoreError } from "../src/node-postgres.ts";

// Copies every repo the panel may suggest into similar_candidates, for a database that read repos before the migration
// 20261121073544_similar_candidates added the triggers that keep the table. Each batch inserts the next repos by ID and
// skips any a trigger already wrote, so the copy never replaces a newer embedding, and a rerun copies only what is
// missing. A batch adds its rows to the HNSW index one by one, and each insert spends most of its time on the graph, so
// workers copy ranges of IDs at once. Repo IDs bunch up, so the IDs are cut into many more ranges than workers, and a
// worker that finishes a sparse range takes the next. Inserts that wait on each other's index pages can outlast the app
// role's 11 s limit, so each worker allows a minute.
// The test matches similarCandidate in src/schema.ts.
const batch = 200;
const workers = Number(process.env.WORKERS ?? 4);

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

// Copies the candidates with IDs above after and at most through, and returns the last ID it read.
const copyBatch = async (client: pg.Client, after: number, through: number) => {
  const { rows } = await client.query<{ last: string | null; read: string; copied: string }>(
    `with next as (
       select id, embedding from repos
       where id > $1 and id <= $2 and embedding is not null and summary is not null and gone_at is null and not archived
       order by id limit $3
     ), copied as (
       insert into similar_candidates (repo_id, embedding) select id, embedding from next
       on conflict (repo_id) do nothing
       returning repo_id
     )
     select (select max(id) from next) as last, (select count(*) from next) as read, (select count(*) from copied) as copied`,
    [after, through, batch],
  );
  const row = rows[0];
  return { last: row?.last == null ? null : Number(row.last), read: Number(row?.read), copied: Number(row?.copied) };
};

const totals = { read: 0, copied: 0 };

const copyRange = Effect.fn("copyRange")(function* (url: string, from: number, through: number) {
  const client = yield* connect(url);
  let after = from;
  for (;;) {
    const done = yield* Effect.promise(() => copyBatch(client, after, through)).pipe(
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
    totals.copied += done.copied;
    if (Math.floor(totals.read / 20_000) > Math.floor(before / 20_000))
      yield* Console.log(`${totals.read} repos read, ${totals.copied} copied`);
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
  const step = Math.ceil((high - low) / ranges);
  const started = performance.now();
  yield* Effect.forEach(
    Array.from({ length: ranges }, (_, index) => low + index * step),
    (from) => copyRange(url, from, Math.min(high, from + step)),
    { concurrency: workers, discard: true },
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  yield* Console.log(`Done in ${seconds} s: ${totals.read} repos read, ${totals.copied} copied`);
});

Effect.runPromise(program);
