import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import pg from "pg";
import { ignoreError } from "../src/node-postgres.ts";

// Fills repo_topics for the repos that existed before 20261122112553_topics added the triggers that keep it. Each batch
// locks its repos in ID order for share first, so no write changes their topics, kinds, name, archived, or gone_at until the
// batch commits, and a write that waited then rewrites the rows itself. A rerun changes nothing, so a run that stops
// can start again from the beginning.
const batch = 2000;

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

const fillBatch = async (client: pg.Client, after: number) => {
  await client.query("begin");
  try {
    const { rows } = await client.query<{ id: string }>(
      "select id from repos where id > $1 order by id limit $2 for share",
      [after, batch],
    );
    const ids = rows.map((row) => Number(row.id));
    const inserted = await client.query(
      `insert into repo_topics (repo_id, topic, kinds, name_key)
       select r.id, tag.topic, r.kinds, lower(regexp_replace(r.name, '[^a-zA-Z0-9]', '', 'g'))
       from repos r cross join lateral jsonb_array_elements_text(r.topics) as tag (topic)
       where r.id = any($1::bigint[]) and jsonb_typeof(r.topics) = 'array' and r.topics <> '[]'::jsonb
         and r.gone_at is null and not r.archived
       on conflict do nothing`,
      [ids],
    );
    await client.query("commit");
    return { ids, added: inserted.rowCount ?? 0 };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
};

const program = Effect.gen(function* () {
  const url = process.env.DATABASE_URL;
  if (url === undefined) return yield* Effect.die(new Error("Set DATABASE_URL to the database to fill"));
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
  let added = 0;
  for (;;) {
    const filled = yield* Effect.promise(() => fillBatch(client, after)).pipe(
      Effect.catchDefect((defect) =>
        lostRace(defect) ? Effect.fail(new BatchLostRace({ after, sqlState: defect.code })) : Effect.die(defect),
      ),
      Effect.tapError((error) => Console.log(error.message)),
      Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 8 }),
    );
    if (filled.ids.length === 0) break;
    after = filled.ids.at(-1) ?? after;
    repos += filled.ids.length;
    added += filled.added;
    if (repos % (batch * 50) === 0) yield* Console.log(`${repos} repos read, ${added} topic rows added`);
  }
  yield* Console.log(`Done: ${repos} repos read, ${added} topic rows added`);
});

Effect.runPromise(Effect.scoped(program));
