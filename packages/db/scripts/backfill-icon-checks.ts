import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import pg from "pg";
import { ignoreError } from "../src/node-postgres.ts";

// Copies each repo's icon check from repos.icon_checked_at into repo_icon_checks, for a database that held repos before
// the migration 20261123081011_repo_icon_checks. Each batch inserts the next repos by ID and skips any that already have
// a row, which a check or the insert trigger wrote since the deploy and is never older than the time a batch copies. A
// rerun writes only what is missing, so a run that stops can start again from the beginning.
const batch = 2000;

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

// Copies the checks of the next repos after the given ID, and returns the last ID it read. A key's version is the part
// before its first slash, as in saveIcon.
const writeBatch = async (client: pg.Client, after: number) => {
  const { rows } = await client.query<{ last: string | null; read: string; written: string }>(
    `with next as (
       select id, icon_checked_at, split_part(icon_key, '/', 1) as key_version from repos
       where id > $1 order by id limit $2
     ), written as (
       insert into repo_icon_checks (repo_id, checked_at, key_version)
       select id, icon_checked_at, key_version from next
       on conflict (repo_id) do nothing
       returning repo_id
     )
     select (select max(id) from next) as last, (select count(*) from next) as read, (select count(*) from written) as written`,
    [after, batch],
  );
  const row = rows[0];
  return { last: row?.last == null ? null : Number(row.last), read: Number(row?.read), written: Number(row?.written) };
};

const program = Effect.gen(function* () {
  const url = process.env.DATABASE_URL;
  if (url === undefined) return yield* Effect.die(new Error("Set DATABASE_URL to the database to backfill"));
  const client = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const connected = new pg.Client({ connectionString: url });
      connected.on("error", ignoreError);
      await connected.connect();
      await connected.query("set statement_timeout = '60s'");
      return connected;
    }),
    (connected) => Effect.promise(() => connected.end()),
  );
  const started = performance.now();
  let after = 0;
  let read = 0;
  let written = 0;
  for (;;) {
    const done = yield* Effect.promise(() => writeBatch(client, after)).pipe(
      Effect.catchDefect((defect) =>
        lostRace(defect) ? Effect.fail(new BatchLostRace({ after, sqlState: defect.code })) : Effect.die(defect),
      ),
      Effect.tapError((error) => Console.log(error.message)),
      Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 8 }),
    );
    if (done.last === null) break;
    after = done.last;
    read += done.read;
    written += done.written;
    if (read % (batch * 50) === 0) yield* Console.log(`${read} repos read, ${written} checks written`);
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  yield* Console.log(`Done in ${seconds} s: ${read} repos read, ${written} checks written`);
});

Effect.runPromise(Effect.scoped(program));
