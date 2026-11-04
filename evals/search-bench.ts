import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Fake from "@stargrep/ai/fake";
import * as Gateway from "@stargrep/ai/gateway";
import * as Models from "@stargrep/ai/models";
import { tokensSpent } from "@stargrep/ai/port";
import { QueryPlan, QueryPlanner, Search, SearchCache } from "@stargrep/core/search";
import * as Db from "@stargrep/db";
import { Login } from "@stargrep/github/schemas";
import { SQL } from "bun";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { layerDb, spans, tracer } from "../packages/core/scripts/runtime.ts";
import queries from "./queries.json" with { type: "json" };

const rounds = 50;
const warmup = 3;

class LoginNotFound extends Schema.TaggedError<LoginNotFound>()("LoginNotFound", { login: Schema.String }) {
  override get message(): string {
    return `No account '${this.login}' in this database`;
  }
}

const spentSince = (from: number, name: string) =>
  spans
    .slice(from)
    .reduce(
      (sum, span) =>
        span.name === name && span.status._tag === "Ended"
          ? sum + Number(span.status.endTime - span.status.startTime) / 1_000_000
          : sum,
      0,
    );

interface Sample {
  readonly total: number;
  readonly model: number;
  readonly embedding: number;
  readonly database: number;
  readonly local: number;
}

const kinds = ["keyword warm", "keyword cold", "planned warm", "planned cold"] as const;
type Kind = (typeof kinds)[number];

const timed = Effect.fn("bench.timed")(function* (
  search: Search.Search["Service"],
  scope: Search.Scope,
  query: string,
) {
  const from = spans.length;
  const [duration] = yield* Effect.timed(search.search({ scope, query, limit: 10 }).pipe(Effect.withTracer(tracer)));
  const total = Duration.toMillis(duration);
  const model = spentSince(from, "TextGeneration.generate");
  const embedding = spentSince(from, "Embeddings.embed");
  return { total, model, embedding, database: spentSince(from, "Db.search.hybrid"), local: total - model - embedding };
});

const quantile = (values: ReadonlyArray<number>, at: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(at * sorted.length) - 1)] ?? 0;
};

const spread = (values: ReadonlyArray<number>) =>
  `${quantile(values, 0.5).toFixed(1).padStart(7)} / ${quantile(values, 0.95).toFixed(1).padStart(7)}`;

const row = (kind: string, samples: ReadonlyArray<Sample>) =>
  [
    kind.padEnd(13),
    spread(samples.map((sample) => sample.total)),
    spread(samples.map((sample) => sample.local)),
    spread(samples.map((sample) => sample.database)),
    spread(samples.map((sample) => sample.model)),
    spread(samples.map((sample) => sample.embedding)),
  ].join("  ");

const uncached = Layer.effect(
  SearchCache.SearchCache,
  SearchCache.make({ get: () => Effect.succeedNone, set: () => Effect.void }),
).pipe(Layer.provide(Digest.layerWebCrypto));

const searchWith = (cache: Layer.Layer<SearchCache.SearchCache>) =>
  Search.make.pipe(
    Effect.provide(
      QueryPlanner.layer.pipe(Layer.provideMerge(cache), Layer.provide(Gateway.layerPlannerTextGeneration)),
    ),
  );

const plannerTokens = tokensSpent(Models.plannerModel).pipe(
  Effect.map(({ input, output }) => `planner tokens: ${input} in, ${output} out`),
);

const bench = Command.make(
  "search-bench",
  {
    logins: Argument.String("login").pipe(Argument.withSchema(Login), Argument.atLeast(1)),
    fakeEmbeddings: Flag.String("fake-embeddings").pipe(
      Flag.withDescription("Embed queries locally with a hash under this model ID, to match a seeded database"),
      Flag.optional,
    ),
  },
  Effect.fn("search-bench")(function* (input) {
    const embeddingModel = Option.getOrElse(input.fakeEmbeddings, () => Models.embeddingModel.id);
    const embeddings = Option.isSome(input.fakeEmbeddings)
      ? Fake.layerEmbeddings({ id: input.fakeEmbeddings.value, dimensions: Models.embeddingModel.dimensions })
      : Gateway.layerEmbeddings(Models.embeddingModel).pipe(Layer.provide(Gateway.layerProviderConfig));
    const sql = new SQL(Redacted.value(yield* Config.Redacted("DATABASE_URL")));
    const selectOne = Effect.promise(async () => {
      const started = performance.now();
      await sql`select 1`;
      return performance.now() - started;
    });
    const keyword = queries.map((query) => query.query).filter((query) => QueryPlan.queryKind(query) !== "sentence");
    const planned = queries
      .map((query) => query.query)
      .filter((query) => QueryPlan.queryKind(query) === "sentence")
      .slice(0, rounds);

    yield* Effect.gen(function* () {
      const db = yield* Db.Db;
      const warm = yield* searchWith(SearchCache.layerMemory);
      const cold = yield* searchWith(uncached);
      yield* Console.log(`${rounds} interleaved rounds after ${warmup} warmup rounds, embeddings ${embeddingModel}`);
      for (const login of input.logins) {
        const account = yield* db.accounts.byLogin(login);
        if (Option.isNone(account)) return yield* new LoginNotFound({ login });
        const scope: Search.Scope = { _tag: "stars", login };
        const [{ count }] = yield* Effect.promise(
          () => sql`select count(*)::int as count from stars where account_id = ${account.value.id}`,
        );
        yield* Effect.forEach([...keyword, ...planned], (query) => warm.search({ scope, query, limit: 10 }), {
          discard: true,
        });

        const samples: Record<Kind, Array<Sample>> = {
          "keyword warm": [],
          "keyword cold": [],
          "planned warm": [],
          "planned cold": [],
        };
        const selects: Array<number> = [];
        for (let round = 0; round < warmup + rounds; round++) {
          const keywordQuery = keyword[round % keyword.length] ?? "";
          const plannedQuery = planned[round % planned.length] ?? "";
          const select = yield* selectOne;
          const results: Record<Kind, Sample> = {
            "keyword warm": yield* timed(warm, scope, keywordQuery),
            "keyword cold": yield* timed(cold, scope, keywordQuery),
            "planned warm": yield* timed(warm, scope, plannedQuery),
            "planned cold": yield* timed(cold, scope, plannedQuery),
          };
          if (round < warmup) continue;
          selects.push(select);
          for (const kind of kinds) samples[kind].push(results[kind]);
        }

        yield* Console.log(`\naccount ${login}, ${count} stars`);
        yield* Console.log(
          "median / p95 ms  total              local work         database           planner model      embedding",
        );
        for (const kind of kinds) yield* Console.log(row(kind, samples[kind]));
        yield* Console.log(`${"select 1".padEnd(13)}  ${spread(selects)}`);
      }
      yield* Console.log(`\n${yield* plannerTokens}`);
    }).pipe(
      Effect.provide(Layer.merge(layerDb(embeddingModel), embeddings)),
      Effect.ensuring(Effect.promise(() => sql.close())),
    );
  }),
);

bench.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
