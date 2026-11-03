import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import pg from "pg";
import * as Db from "../src/db.ts";
import { Embedding } from "../src/embedding.ts";
import { EmbeddingModel, GitHubAccountId } from "../src/ids.ts";

const adminUrl = process.env.DATABASE_URL ?? "postgres://stargrep:stargrep@127.0.0.1:54317/stargrep";
const repoCount = 100_000;
const starCount = 5_000;
const accountCount = 50;
const rounds = 100;
const warmup = 5;
const model = Schema.decodeSync(EmbeddingModel)("bench/random-1024");
const accountId = Schema.decodeSync(GitHubAccountId)(1);
const words = [
  "terminal",
  "dashboard",
  "rust",
  "database",
  "editor",
  "react",
  "compiler",
  "parser",
  "cli",
  "graph",
  "vector",
  "search",
  "voice",
  "dictation",
  "image",
  "video",
  "audio",
  "game",
  "engine",
  "physics",
  "kubernetes",
  "docker",
  "proxy",
  "cache",
  "queue",
  "stream",
  "auth",
  "crypto",
  "wallet",
  "chat",
  "email",
  "calendar",
  "notes",
  "markdown",
  "pdf",
  "spreadsheet",
  "orm",
  "sql",
  "http",
  "router",
  "testing",
  "linter",
  "formatter",
  "bundler",
  "font",
  "icon",
  "theme",
  "animation",
  "chart",
  "map",
  "robot",
  "drone",
  "embedded",
  "firmware",
  "shell",
  "git",
  "diff",
  "backup",
  "sync",
  "monitor",
  "logging",
  "metrics",
  "tracing",
  "scheduler",
];

const benchUrl = (() => {
  const url = new URL(adminUrl);
  url.pathname = "/stargrep_bench";
  return url.href;
})();

const withClient = <A>(url: string, use: (client: pg.Client) => Promise<A>) =>
  Effect.promise(async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await use(client);
    } finally {
      await client.end();
    }
  });

const prepare = withClient(adminUrl, async (client) => {
  const { rowCount } = await client.query("select 1 from pg_database where datname = 'stargrep_bench'");
  if (rowCount === 0) await client.query("create database stargrep_bench");
}).pipe(
  Effect.andThen(
    Effect.promise(async () => {
      const pool = new pg.Pool({ connectionString: benchUrl });
      await migrate(drizzle({ client: pool }), {
        migrationsFolder: new URL("../migrations", import.meta.url).pathname,
      });
      await pool.end();
    }),
  ),
  Effect.andThen(
    withClient(benchUrl, async (client) => {
      const { rows } = await client.query("select count(*)::int as count from repos where embedding_model = $1", [
        model,
      ]);
      if (rows[0]?.count === repoCount) return false;
      await client.query("truncate repos, github_accounts cascade");
      await client.query(
        "insert into github_accounts (id, type, login) select g, 'user', 'bench-' || g from generate_series(1, $1::int) g",
        [accountCount],
      );
      await client.query(
        `insert into repos (id, owner, name, summary, embedding, embedding_model)
         select g, 'owner-' || (g % 5000), 'repo-' || g,
           (select string_agg(($1::text[])[1 + floor(random() * cardinality($1::text[]))::int], ' ')
              from generate_series(1, 24) where g > 0),
           (select array_agg(random() - 0.5)::real[] from generate_series(1, 1024) where g > 0)::halfvec,
           $2
         from generate_series(1, $3::int) g`,
        [words, model, repoCount],
      );
      await client.query(
        `insert into stars (account_id, repo_id, starred_at, source)
         select a, r.id, now() - random() * interval '1000 days', 'api'
         from generate_series(1, $1::int) a
         cross join lateral (select id from repos where a > 0 order by random() limit $2) r`,
        [accountCount, starCount],
      );
      await client.query("vacuum analyze");
      return true;
    }),
  ),
);

const decodeEmbedding = Schema.decodeEffect(Embedding);

const randomEmbedding = Effect.gen(function* () {
  const vector: Array<number> = [];
  for (let index = 0; index < 1024; index++) vector.push((yield* Random.next) - 0.5);
  return yield* decodeEmbedding({ model, vector });
});

const randomText = Effect.gen(function* () {
  const first = words[yield* Random.nextIntBetween(0, words.length)];
  const second = words[yield* Random.nextIntBetween(0, words.length)];
  return `${first} ${second}`;
});

const summarize = (name: string, samples: ReadonlyArray<number>, rows: ReadonlyArray<number>) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)] ?? 0;
  const fixed = (ms: number) => ms.toFixed(2);
  return `${name.padEnd(13)} median ${fixed(at(0.5))} ms  p95 ${fixed(at(0.95))} ms  min ${fixed(sorted[0] ?? 0)} ms  max ${fixed(sorted.at(-1) ?? 0)} ms  rows ${Math.min(...rows)}-${Math.max(...rows)}`;
};

const bench = Effect.gen(function* () {
  const seeded = yield* prepare;
  yield* Console.log(
    seeded
      ? `seeded ${repoCount} repos and ${starCount} stars for each of ${accountCount} accounts`
      : "reused the seeded database",
  );
  const db = yield* Db.Db;

  const timed = <A, E>(effect: Effect.Effect<ReadonlyArray<A>, E>) =>
    Effect.timed(effect).pipe(Effect.map(([duration, rows]) => [Duration.toMillis(duration), rows.length] as const));
  const lookup = timed(db.accounts.get(accountId).pipe(Effect.map((account) => [account])));
  const nearest = (embedding: Embedding) => timed(db.search.nearestStars({ accountId, embedding, limit: 20 }));
  const hybrid = (embedding: Embedding, text: string) =>
    timed(db.search.hybridStars({ accountId, text, embedding, limit: 20 }));

  const results = { lookup: [] as Array<number>, nearest: [] as Array<number>, hybrid: [] as Array<number> };
  const counts = { lookup: [] as Array<number>, nearest: [] as Array<number>, hybrid: [] as Array<number> };
  for (let round = 0; round < warmup + rounds; round++) {
    const embedding = yield* randomEmbedding;
    const text = yield* randomText;
    const [lookupMs, lookupRows] = yield* lookup;
    const [nearestMs, nearestRows] = yield* nearest(embedding);
    const [hybridMs, hybridRows] = yield* hybrid(embedding, text);
    if (round < warmup) continue;
    results.lookup.push(lookupMs);
    results.nearest.push(nearestMs);
    results.hybrid.push(hybridMs);
    counts.lookup.push(lookupRows);
    counts.nearest.push(nearestRows);
    counts.hybrid.push(hybridRows);
  }

  yield* Console.log(
    `${rounds} interleaved rounds after ${warmup} warmup rounds, ${starCount} stars of ${repoCount} repos`,
  );
  yield* Console.log(summarize("pk lookup", results.lookup, counts.lookup));
  yield* Console.log(summarize("exact vector", results.nearest, counts.nearest));
  yield* Console.log(summarize("hybrid rrf", results.hybrid, counts.hybrid));
}).pipe(Effect.provide(Db.layerNodePostgres({ connectionString: Redacted.make(benchUrl), embeddingModel: model })));

await Effect.runPromise(bench);
