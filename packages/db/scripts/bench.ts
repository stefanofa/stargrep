import { GitHubAccountId, Login } from "@stargrep/github/schemas";
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
const libraryLogin = Schema.decodeSync(Login)("bench-library");
const libraryAccountId = Schema.decodeSync(GitHubAccountId)(accountCount + 1);
const libraryStars = 3_000;
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

// One account with a typical library. Half of all repos wait for a new README, and 44,000 of those are capped,
// the case where a sweep could slow down as failed repos pile up. Every statement converges, so a rerun changes
// nothing. The hour of backoff stands in for EnrichRetry.retryDelays, which packages/db cannot import.
const prepareLibrary = withClient(benchUrl, async (client) => {
  await client.query("set statement_timeout = 0");
  await client.query("insert into github_accounts (id, type, login) values ($1, 'user', $2) on conflict do nothing", [
    libraryAccountId,
    libraryLogin,
  ]);
  await client.query(
    `insert into stars (account_id, repo_id, starred_at, observed_at, source)
     select $1, id, now() - (id % 1000) * interval '1 day', now(), 'api'
     from repos where id % ($3::int / $2::int) = 0 order by id limit $2
     on conflict do nothing`,
    [libraryAccountId, libraryStars, repoCount],
  );
  await client.query("update repos set readme_oid = repeat('a', 40) where id % 2 = 0 and readme_oid is null");
  await client.query(
    "update repos set enrich_failures = $1 where id % 2 = 0 and id % 100 < 88 and enrich_failures = 0",
    [Db.enrichFailureCap],
  );
  await client.query(
    "update repos set enrich_failures = 1, enrich_retry_at = now() + interval '1 hour' where id % 2 = 0 and id % 100 between 88 and 91 and enrich_failures = 0",
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

type Sample = readonly [millis: number, rows: number];

const measureRounds = Effect.fn("bench.measureRounds")(function* <E>(
  round: Effect.Effect<Readonly<Record<string, Sample>>, E>,
) {
  const results: Record<string, { readonly millis: Array<number>; readonly rows: Array<number> }> = {};
  for (let index = 0; index < warmup + rounds; index++) {
    const samples = yield* round;
    if (index < warmup) continue;
    for (const [name, [millis, rows]] of Object.entries(samples)) {
      const result = results[name] ?? { millis: [], rows: [] };
      results[name] = result;
      result.millis.push(millis);
      result.rows.push(rows);
    }
  }
  for (const [name, { millis, rows }] of Object.entries(results)) yield* Console.log(summarize(name, millis, rows));
});

const measure = Effect.gen(function* () {
  const db = yield* Db.Db;

  const timed = <A, E>(effect: Effect.Effect<ReadonlyArray<A>, E>) =>
    Effect.timed(effect).pipe(Effect.map(([duration, rows]): Sample => [Duration.toMillis(duration), rows.length]));
  const scope: Db.SearchScope = { kind: "stars", accountId };
  const plain = { scope, limit: 20, name: null, metrics: [], filters: Db.noFilters, rankBy: null };

  yield* Console.log(
    `${rounds} interleaved rounds after ${warmup} warmup rounds, ${starCount} stars of ${repoCount} repos`,
  );
  yield* measureRounds(
    Effect.gen(function* () {
      const embedding = yield* randomEmbedding;
      const text = yield* randomText;
      return {
        "pk lookup": yield* timed(db.accounts.get(accountId).pipe(Effect.map((account) => [account]))),
        "vector only": yield* timed(db.search.hybrid({ ...plain, text: "", embedding })),
        "hybrid rrf": yield* timed(db.search.hybrid({ ...plain, text, embedding })),
      };
    }),
  );

  const progress = yield* db.stars.enrichment(libraryLogin);
  yield* Console.log(
    `${rounds} rounds after ${warmup} warmup rounds, one library of ${progress.total} stars, ${progress.read} read and ${progress.failed} failed`,
  );
  yield* measureRounds(
    Effect.gen(function* () {
      return {
        progress: yield* timed(db.stars.enrichment(libraryLogin).pipe(Effect.map((counts) => [counts]))),
        library: yield* timed(db.stars.library(libraryAccountId)),
        sweep: yield* timed(db.repos.sweepable({ now: yield* DateTime.now, limit: 100 })),
      };
    }),
  );
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
