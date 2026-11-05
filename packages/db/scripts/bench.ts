import { GitHubAccountId } from "@stargrep/github/schemas";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Db from "../src/db.ts";
import { Embedding, EmbeddingModelId } from "../src/embedding.ts";
import { createMigratedDatabase, databaseUrl, withClient } from "../src/local-database.ts";

const adminUrl = process.env.DATABASE_URL ?? "postgres://stargrep:stargrep@127.0.0.1:54317/stargrep";
const repoCount = 100_000;
const starCount = 5_000;
const accountCount = 50;
const rounds = 100;
const warmup = 5;
const model = Schema.decodeSync(EmbeddingModelId)("bench/random-1024");
const accountId = Schema.decodeSync(GitHubAccountId)(1);
const libraryAccountId = Schema.decodeSync(GitHubAccountId)(accountCount + 1);
const libraryStars = 3_000;
const maxFailures = 3;
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

const benchDatabase = "stargrep_bench";
const benchUrl = databaseUrl(adminUrl, benchDatabase);

const prepare = createMigratedDatabase(adminUrl, benchDatabase).pipe(
  Effect.andThen(
    withClient(benchUrl, async (client) => {
      const { rows } = await client.query("select count(*)::int as count from repos where embedding_model = $1", [
        model,
      ]);
      if (rows[0]?.count === repoCount) return false;
      // Seeding runs single statements for longer than the role's 11 second statement timeout.
      await client.query("set statement_timeout = 0");
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
        `insert into stars (account_id, repo_id, starred_at, observed_at, source)
         select a, r.id, r.starred_at, r.starred_at, 'api'
         from generate_series(1, $1::int) a
         cross join lateral (
           select id, now() - random() * interval '1000 days' as starred_at from repos where a > 0 order by random() limit $2
         ) r`,
        [accountCount, starCount],
      );
      await client.query("vacuum analyze");
      return true;
    }),
  ),
);

// One account with a typical library, where a tenth of all repos wait for a new README and a hundredth failed.
// Every statement converges, so a rerun leaves the database as it found it.
const prepareLibrary = withClient(benchUrl, async (client) => {
  await client.query("set statement_timeout = 0");
  await client.query(
    "insert into github_accounts (id, type, login) values ($1, 'user', 'bench-library') on conflict do nothing",
    [libraryAccountId],
  );
  await client.query(
    `insert into stars (account_id, repo_id, starred_at, observed_at, source)
     select $1, id, now() - (id % 1000) * interval '1 day', now(), 'api'
     from repos where id % ($3::int / $2::int) = 0 order by id limit $2
     on conflict do nothing`,
    [libraryAccountId, libraryStars, repoCount],
  );
  await client.query("update repos set readme_oid = repeat('a', 40) where id % 10 = 0 and readme_oid is null");
  await client.query(
    "update repos set enrich_failures = 3, enrich_failed_at = now() where id % 100 = 0 and enrich_failures = 0",
  );
  await client.query("vacuum analyze repos, stars");
});

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

const measure = Effect.gen(function* () {
  const db = yield* Db.Db;

  const timed = <A, E>(effect: Effect.Effect<ReadonlyArray<A>, E>) =>
    Effect.timed(effect).pipe(Effect.map(([duration, rows]) => [Duration.toMillis(duration), rows.length] as const));
  const lookup = timed(db.accounts.get(accountId).pipe(Effect.map((account) => [account])));
  const scope: Db.SearchScope = { kind: "stars", accountId };
  const plain = { scope, limit: 20, name: null, metrics: [], filters: Db.noFilters, rankBy: null };
  const nearest = (embedding: Embedding) => timed(db.search.hybrid({ ...plain, text: "", embedding }));
  const hybrid = (embedding: Embedding, text: string) => timed(db.search.hybrid({ ...plain, text, embedding }));

  const progress = timed(
    db.stars.enrichment({ accountId: libraryAccountId, maxFailures }).pipe(Effect.map((counts) => [counts])),
  );
  const library = timed(db.stars.library(libraryAccountId));
  const cutoffs = [
    DateTime.subtract(yield* DateTime.now, { minutes: 10 }),
    DateTime.subtract(yield* DateTime.now, { hours: 1 }),
  ];
  const sweep = timed(db.repos.sweepable({ cutoffs, limit: 100 }));
  const libraryResults = { progress: [] as Array<number>, library: [] as Array<number>, sweep: [] as Array<number> };
  const libraryCounts = { progress: [] as Array<number>, library: [] as Array<number>, sweep: [] as Array<number> };
  for (let round = 0; round < warmup + rounds; round++) {
    const [progressMs, progressRows] = yield* progress;
    const [libraryMs, libraryRows] = yield* library;
    const [sweepMs, sweepRows] = yield* sweep;
    if (round < warmup) continue;
    libraryResults.progress.push(progressMs);
    libraryResults.library.push(libraryMs);
    libraryResults.sweep.push(sweepMs);
    libraryCounts.progress.push(progressRows);
    libraryCounts.library.push(libraryRows);
    libraryCounts.sweep.push(sweepRows);
  }
  const progressCounts = yield* db.stars.enrichment({ accountId: libraryAccountId, maxFailures });
  yield* Console.log(
    `progress counts total ${progressCounts.total}, read ${progressCounts.read}, failed ${progressCounts.failed}`,
  );

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
  yield* Console.log(summarize("vector only", results.nearest, counts.nearest));
  yield* Console.log(summarize("hybrid rrf", results.hybrid, counts.hybrid));
  yield* Console.log(`${rounds} rounds after ${warmup} warmup rounds, one library of ${libraryStars} stars`);
  yield* Console.log(summarize("progress", libraryResults.progress, libraryCounts.progress));
  yield* Console.log(summarize("library", libraryResults.library, libraryCounts.library));
  yield* Console.log(summarize("sweep", libraryResults.sweep, libraryCounts.sweep));
}).pipe(Effect.provide(Db.layerNodePostgres({ connectionString: Redacted.make(benchUrl), embeddingModel: model })));

const bench = Effect.gen(function* () {
  const seeded = yield* prepare;
  yield* Console.log(
    seeded
      ? `seeded ${repoCount} repos and ${starCount} stars for each of ${accountCount} accounts`
      : "reused the seeded database",
  );
  yield* prepareLibrary;
  yield* measure;
});

await Effect.runPromise(bench);
