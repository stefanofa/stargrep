import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Embeddings from "@stargrep/ai/embeddings";
import * as Local from "@stargrep/ai/local";
import * as Db from "@stargrep/db";
import { BudgetShare } from "@stargrep/github/schemas";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as StarImport from "../src/stars/star-import.ts";
import * as StarSync from "../src/stars/star-sync.ts";
import * as Runtime from "./runtime.ts";
import {
  type Account,
  FailureJson,
  layerPendingFile,
  parseLogins,
  parsePending,
  ReportJson,
  statePaths,
} from "./star-import-files.ts";

const state = Flag.String("state").pipe(
  Flag.withDescription("The directory that keeps pending.txt, the repos the import found, and failures.jsonl"),
  Flag.withDefault(".cache/star-import"),
);

// A start the CLI refuses, before it opens a database or reads GitHub, so the command exits non-zero.
class StarImportRefused extends Schema.TaggedError<StarImportRefused, { readonly brand: unique symbol }>()(
  "StarImportRefused",
  { reason: Schema.String },
) {
  override get message(): string {
    return `import-stars refuses to start: ${this.reason}`;
  }
}

// A driver that crashed holds the import until its heartbeat goes stale, so a rerun waits that long for it.
const waitForOwner = {
  schedule: Schedule.spaced(Duration.seconds(10)),
  times: 9,
  while: (error: StarImport.StarImportAbort) => error._tag === "StarImportBusy",
};

// The database with the embedding model the environment configures, which must be the one the database holds.
const layerDb = Layer.unwrap(
  Effect.map(Embeddings.Embeddings, (embeddings) => Runtime.layerDb(embeddings.model.id)),
).pipe(Layer.provideMerge(Local.layer));

// GitHub on GITHUB_TOKEN, one request per account at a time within the token's share, and the pending file in place of
// the enrichment queue, so the import shares nothing with the Worker but the database.
const layerImport = (pendingFile: string, github: { readonly readers: number; readonly share: BudgetShare }) =>
  StarSync.layerWithoutEmbedding.pipe(
    Layer.provideMerge(layerDb),
    Layer.provideMerge(Runtime.layerGitHubBulk(github)),
    Layer.provide(layerPendingFile(pendingFile)),
  );

// GitHub asks for few requests at once on one token, and a few readers already reach the share.
const maxConcurrency = 8;

const decodeShare = Schema.decodeUnknownOption(BudgetShare);

const readLogins = Effect.fn("importStars.readLogins")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError(() => new StarImportRefused({ reason: `cannot read the login list ${path}` })));
  const { logins, invalid } = parseLogins(text);
  if (invalid.length > 0) {
    return yield* new StarImportRefused({
      reason: `${path} has lines whose first column is not a login: ${invalid.slice(0, 10).join(", ")}`,
    });
  }
  return logins;
});

// GitHub requests to /users/<login>/starred, the star list pages, retries included.
const starPagesSent = () => Runtime.requests.millis.get("users")?.length ?? 0;
const starPagesOf = (login: string) => Runtime.requests.byPath.get(`/users/${login.toLowerCase()}/starred`) ?? 0;

const describe = (outcome: StarImport.Outcome, pages: number) => {
  switch (outcome._tag) {
    case "Imported":
      return `imported ${outcome.report.listed} stars in ${pages} pages, ${outcome.report.enqueued} new repos, ${outcome.embedded} embedded, ${(outcome.millis / 1000).toFixed(1)} s`;
    case "AlreadySynced":
      return outcome.embedded === 0 ? "already synced" : `already synced, ${outcome.embedded} embedded`;
    case "TooManyStars":
      return `skipped, ${outcome.stars} stars is over --max-stars`;
    case "Missing":
      return "GitHub has no such account";
    case "Failed":
      return `failed on attempt ${outcome.attempt}: ${outcome.reason}`;
  }
};

const entryOf = (outcome: StarImport.Outcome, pages: number): Account => {
  switch (outcome._tag) {
    case "Imported":
      return {
        login: outcome.login,
        attempt: outcome.attempt,
        outcome: outcome._tag,
        stars: outcome.report.listed,
        pages,
        rows: outcome.report.added,
        newRepos: outcome.report.enqueued,
        embedded: outcome.embedded,
        millis: outcome.millis,
      };
    case "AlreadySynced":
      return { login: outcome.login, attempt: outcome.attempt, outcome: outcome._tag, embedded: outcome.embedded };
    case "TooManyStars":
      return { login: outcome.login, attempt: outcome.attempt, outcome: outcome._tag, stars: outcome.stars };
    case "Failed":
      return { login: outcome.login, attempt: outcome.attempt, outcome: outcome._tag, pages, reason: outcome.reason };
    case "Missing":
      return { login: outcome.login, attempt: outcome.attempt, outcome: outcome._tag };
  }
};

const runImport = Command.make(
  "run",
  {
    logins: Flag.String("logins").pipe(
      Flag.withDescription(
        "The login list, one login per line in the order to import them. Only a line's first tab-separated column is read",
      ),
    ),
    maxStars: Flag.Int("max-stars").pipe(
      Flag.withDescription(
        "Skip an account that has starred more repos than this. GitHub stops listing a very long list before its end",
      ),
      Flag.withDefault(20_000),
    ),
    concurrency: Flag.Int("concurrency").pipe(
      Flag.withDescription(
        "Accounts to read at once, each one request at a time. A secondary rate limit from GitHub takes one away",
      ),
      Flag.withDefault(1),
    ),
    share: Flag.Finite("share").pipe(
      Flag.withDescription(
        "The most of each of the token's hourly limits the import spends, above 0 and at most 1. It waits for the window to reset once that is spent",
      ),
      Flag.withDefault(0.5),
    ),
    state,
    out: Flag.String("out").pipe(Flag.withDescription("Where to write the run's report as JSON"), Flag.optional),
  },
  Effect.fn("importStars.run")(function* (flags) {
    if (flags.maxStars < 0) return yield* new StarImportRefused({ reason: "--max-stars takes 0 or more" });
    if (flags.concurrency < 1 || flags.concurrency > maxConcurrency) {
      return yield* new StarImportRefused({ reason: `--concurrency takes 1 to ${maxConcurrency}` });
    }
    const share = decodeShare(flags.share);
    if (Option.isNone(share))
      return yield* new StarImportRefused({ reason: "--share takes more than 0 and at most 1" });
    const logins = yield* readLogins(flags.logins);
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* statePaths(flags.state);
    yield* fs.makeDirectory(flags.state, { recursive: true });
    const total = Arr.dedupeWith(logins, (a, b) => a.toLowerCase() === b.toLowerCase()).length;
    yield* Console.log(
      `import-stars: ${total} logins, ${flags.concurrency} at once within ${flags.share} of the token's limit, accounts over ${flags.maxStars} stars skipped, pending repos to ${paths.pending}, failures to ${paths.failures}`,
    );

    const started = yield* Clock.currentTimeMillis;
    const accounts: Array<Account> = [];
    const totals = { tried: 0, imported: 0, rows: 0, newRepos: 0, embedded: 0, failed: [] as ReadonlyArray<string> };
    // Accounts overlap, so each one's pages are the requests for its own list since its last outcome. Two workers never
    // read one login at once.
    const counted = new Map<string, number>();
    const pagesOf = (login: string) => {
      const sent = starPagesOf(login);
      const pages = sent - (counted.get(login.toLowerCase()) ?? 0);
      counted.set(login.toLowerCase(), sent);
      return pages;
    };
    const pagesPerHour = (now: number) =>
      Math.round(starPagesSent() / Math.max((now - started) / 3_600_000, 1 / 3_600));

    const onOutcome = Effect.fn("importStars.onOutcome")(function* (outcome: StarImport.Outcome) {
      const pages = pagesOf(outcome.login);
      accounts.push(entryOf(outcome, pages));
      if (outcome._tag === "Imported") {
        totals.imported++;
        totals.rows += outcome.report.added;
        totals.newRepos += outcome.report.enqueued;
      }
      if (outcome._tag === "Imported" || outcome._tag === "AlreadySynced") totals.embedded += outcome.embedded;
      if (outcome._tag === "Failed") {
        const at = DateTime.formatIso(yield* DateTime.now);
        const line = yield* Schema.encodeEffect(FailureJson)({ ...outcome, at });
        yield* fs.writeFileString(paths.failures, `${line}\n`, { flag: "a" });
      }
      if (outcome.attempt === 1) totals.tried++;
      const position = outcome.attempt === 1 ? `${totals.tried}/${total}` : `retry ${outcome.attempt - 1}`;
      yield* Console.log(
        `[${position}] ${outcome.login}: ${describe(outcome, pages)} | ${totals.imported} imported, ${starPagesSent()} pages, ${totals.rows} rows, ${totals.newRepos} new repos, ${totals.embedded} embedded, ${pagesPerHour(yield* Clock.currentTimeMillis)} pages/h`,
      );
    }, Effect.orDie);

    // The report is written however the run ends, so a run stopped with Ctrl-C still says what it did.
    const write = Effect.fn("importStars.writeReport")(function* (finished: boolean) {
      const now = yield* Clock.currentTimeMillis;
      const counts = new Map<string, number>();
      for (const account of accounts) counts.set(account.outcome, (counts.get(account.outcome) ?? 0) + 1);
      yield* Console.log(
        `outcomes: ${[...counts].map(([outcome, count]) => `${outcome} ${count}`).join(", ") || "none"}`,
      );
      if (totals.failed.length > 0) yield* Console.log(`still failing: ${totals.failed.join(", ")}`);
      yield* Console.log(
        `elapsed: ${((now - started) / 1000).toFixed(1)} s, ${starPagesSent()} pages, ${pagesPerHour(now)} pages/h${finished ? "" : ", stopped before the end"}`,
      );
      if (Option.isNone(flags.out)) return;
      const json = yield* Schema.encodeEffect(ReportJson)({
        elapsedMillis: now - started,
        finished,
        pages: starPagesSent(),
        pagesPerHour: pagesPerHour(now),
        failed: totals.failed,
        accounts,
      });
      yield* fs.writeFileString(flags.out.value, json);
    }, Effect.orDie);

    yield* StarImport.run({
      logins,
      maxStars: flags.maxStars,
      retries: 3,
      concurrency: flags.concurrency,
      onOutcome,
    }).pipe(
      Effect.tapError((error) =>
        error._tag === "StarImportBusy"
          ? Console.log("another star import driver holds this database, waiting")
          : Effect.void,
      ),
      Effect.retry(waitForOwner),
      Effect.tap((done) => Effect.sync(() => (totals.failed = done.failed))),
      Effect.onExit((exit) => write(exit._tag === "Success")),
      Effect.provide(layerImport(paths.pending, { readers: flags.concurrency, share: share.value })),
    );
  }),
).pipe(
  Command.withDescription(
    "Import the stars of a list of logins in order, --concurrency accounts at a time on GITHUB_TOKEN, within --share of its hourly limit. A rerun skips the accounts the database already synced.",
  ),
);

const summaries = Command.make(
  "summaries",
  {
    state,
    minStars: Flag.Int("min-stars").pipe(
      Flag.withDescription("List only repos with at least this many GitHub stars"),
      Flag.withDefault(200),
    ),
  },
  Effect.fn("importStars.summaries")(function* (flags) {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* statePaths(flags.state);
    const text = yield* fs
      .readFileString(paths.pending)
      .pipe(Effect.mapError(() => new StarImportRefused({ reason: `cannot read ${paths.pending}` })));
    const ids = parsePending(text);
    const db = yield* Db.Db;
    const found = yield* Effect.forEach(Arr.chunksOf(ids, 10_000), (chunk) =>
      db.repos.summaryCandidates({ ids: chunk, minStars: flags.minStars }),
    );
    const listed = found.flat().toSorted((a, b) => b.stars - a.stars || a.id - b.id);
    if (listed.length > 0) yield* Console.log(listed.map((repo) => `${repo.id} ${repo.owner}/${repo.name}`).join("\n"));
    yield* Console.error(
      `${listed.length} of ${ids.length} imported repos wait for a summary and have ${flags.minStars} or more stars`,
    );
  }, Effect.provide(layerDb)),
).pipe(
  Command.withDescription(
    "Print '<id> <owner>/<name>' for each imported repo that waits for a summary and has enough stars, most starred first, the list prefill --ids reads.",
  ),
);

Command.make("import-stars").pipe(
  Command.withSubcommands([runImport, summaries]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
