import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import pg from "pg";
import { ignoreError } from "../src/node-postgres.ts";

// Sets every repo's synced_stargazers from stars, for a database whose triggers from 20261118103946_sweep_order_index
// started counting at zero. Each batch locks its rows in ID order first, so the count it reads in the next statement
// holds every star committed before the lock, and a star still in flight adds itself once the batch commits. A rerun
// changes nothing that is right, so a run that stops can start again from the beginning.
const batch = 1000;

// Postgres aborts one side of a deadlock or a serialization failure so the other can commit. The batch then rolls back
// whole, so it runs again from the same ID.
const lostRace = (error: unknown): error is pg.DatabaseError & { readonly code: string } =>
  error instanceof pg.DatabaseError && (error.code === "40P01" || error.code === "40001");

class BatchLostRace extends Schema.TaggedError<BatchLostRace, { readonly brand: unique symbol }>()("BatchLostRace", {
  after: Schema.Number,
  sqlState: Schema.String,
}) {
  override get message(): string {
    return `The batch after repo ${this.after} lost a race (${this.sqlState})`;
  }
}

const countBatch = async (client: pg.Client, after: number) => {
  await client.query("begin");
  try {
    const { rows } = await client.query<{ id: string }>(
      "select id from repos where id > $1 order by id limit $2 for no key update",
      [after, batch],
    );
    const ids = rows.map((row) => Number(row.id));
    const updated = await client.query(
      `update repos r set synced_stargazers = c.stargazers
       from (
         select l.id, (select count(*)::integer from stars s where s.repo_id = l.id and s.unstarred_at is null) as stargazers
         from unnest($1::bigint[]) as l (id)
       ) c
       where r.id = c.id and r.synced_stargazers <> c.stargazers`,
      [ids],
    );
    await client.query("commit");
    return { ids, changed: updated.rowCount ?? 0 };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
};

const program = Effect.gen(function* () {
  const url = process.env.DATABASE_URL;
  if (url === undefined) return yield* Effect.die(new Error("Set DATABASE_URL to the database to count"));
  const client = yield* Effect.acquireRelease(
    Effect.promise(async () => {
      const connected = new pg.Client({ connectionString: url });
      connected.on("error", ignoreError);
      await connected.connect();
      return connected;
    }),
    (connected) => Effect.promise(() => connected.end()),
  );
  let after = 0;
  let repos = 0;
  let changed = 0;
  for (;;) {
    const counted = yield* Effect.promise(() => countBatch(client, after)).pipe(
      Effect.catchDefect((defect) =>
        lostRace(defect) ? Effect.fail(new BatchLostRace({ after, sqlState: defect.code })) : Effect.die(defect),
      ),
      Effect.tapError((error) => Console.log(error.message)),
      Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 8 }),
    );
    if (counted.ids.length === 0) break;
    after = counted.ids.at(-1) ?? after;
    repos += counted.ids.length;
    changed += counted.changed;
    if (repos % (batch * 50) === 0) yield* Console.log(`${repos} repos read, ${changed} counts set`);
  }
  yield* Console.log(`Done: ${repos} repos read, ${changed} counts set`);
});

Effect.runPromise(Effect.scoped(program));
