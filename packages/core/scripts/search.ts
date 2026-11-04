import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Gateway from "@stargrep/ai/gateway";
import * as Models from "@stargrep/ai/models";
import { tokensSpent } from "@stargrep/ai/port";
import * as Db from "@stargrep/db";
import { Login } from "@stargrep/github/schemas";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Schema from "effect/Schema";
import * as QueryPlanner from "../src/search/query-planner.ts";
import * as Search from "../src/search/search.ts";
import * as SearchCache from "../src/search/search-cache.ts";
import { ended, layerDb, millis, tracer } from "./runtime.ts";

class LoginNotFound extends Schema.TaggedError<LoginNotFound>()("LoginNotFound", { login: Schema.String }) {
  override get message(): string {
    return `No account '${this.login}' in this database. Sync it first with \`bun run --cwd packages/core sync ${this.login}\``;
  }
}

const timings = (name: string) => {
  const finished = ended(name);
  return finished.length === 0
    ? "none"
    : `${finished.map((status) => millis(status.endTime - status.startTime)).join(" + ")} ms`;
};

const tokens = (model: string) =>
  tokensSpent(model).pipe(Effect.map(({ input, output }) => `${model} ${input} in, ${output} out`));

const describeFilters = ({ filters }: Search.SearchOutcome["plan"]) =>
  [
    ...(filters.languages.length > 0 ? [`languages ${filters.languages.join(", ")}`] : []),
    ...(filters.kinds.length > 0 ? [`kinds ${filters.kinds.join(", ")}`] : []),
    ...(filters.licenses.length > 0 ? [`licenses ${filters.licenses.join(", ")}`] : []),
    ...(filters.archived === null ? [] : [filters.archived ? "archived only" : "not archived"]),
    ...(filters.starredAfter === null ? [] : [`starred on or after ${DateTime.formatIsoDate(filters.starredAfter)}`]),
    ...(filters.starredBefore === null ? [] : [`starred before ${DateTime.formatIsoDate(filters.starredBefore)}`]),
    ...filters.metrics.map((bound) => `${bound.metric} ${bound.op} ${bound.value}`),
  ].join("; ") || "none";

const layerSearch = Search.layer.pipe(
  Layer.provideMerge(QueryPlanner.layer.pipe(Layer.provide(Gateway.layerPlannerTextGeneration))),
  Layer.provideMerge(
    SearchCache.layerKeyValueStore.pipe(Layer.provide(KeyValueStore.layerFileSystem(".cache/search"))),
  ),
  Layer.provideMerge(Gateway.layerEmbeddings(Models.embeddingModel).pipe(Layer.provide(Gateway.layerProviderConfig))),
  Layer.provideMerge(layerDb(Models.embeddingModel.id)),
);

const search = Command.make(
  "search",
  {
    login: Argument.String("login").pipe(Argument.withSchema(Login)),
    query: Argument.String("query"),
    limit: Flag.Int("limit").pipe(Flag.withDescription("How many results to print"), Flag.withDefault(10)),
  },
  Effect.fn("search")(
    function* (input) {
      const db = yield* Db.Db;
      const account = yield* db.accounts.byLogin(input.login);
      if (Option.isNone(account)) return yield* new LoginNotFound({ login: input.login });
      const outcome = yield* (yield* Search.Search)
        .search({ scope: { _tag: "stars", accountId: account.value.id }, query: input.query, limit: input.limit })
        .pipe(Effect.withTracer(tracer));
      const { plan } = outcome;
      yield* Console.log(`query: ${input.query}`);
      yield* Console.log(`plan: ${outcome.planSource}`);
      yield* Console.log(`  semantic text: ${plan.semanticText}`);
      yield* Console.log(`  full text: ${plan.textQuery || "none"}`);
      yield* Console.log(`  exact name: ${plan.exactName ?? "none"}`);
      yield* Console.log(`  filters: ${describeFilters(plan)}`);
      yield* Console.log(
        `  ranking: ${plan.ranking._tag === "metric" ? `${plan.ranking.metric}, ${plan.ranking.direction} first` : "relevance"}`,
      );
      yield* Console.log(
        `timings: search ${timings("Search.search")}, planner model ${timings("TextGeneration.generate")}, embedding ${timings("Embeddings.embed")}, database ${timings("Db.search.hybrid")}`,
      );
      yield* Console.log(`tokens: ${yield* tokens(Models.plannerModel)}; ${yield* tokens(Models.embeddingModel.id)}`);
      yield* Console.log(`results: ${outcome.results.length}`);
      for (const [index, result] of outcome.results.entries()) {
        const language = result.repo.language === null ? "" : `  (${result.repo.language})`;
        yield* Console.log(`${String(index + 1).padStart(2)}. ${result.repo.owner}/${result.repo.name}${language}`);
        yield* Console.log(`    ${Search.reasonLine(result)}`);
      }
    },
    Effect.tapError((error) => Console.error(`failed: ${error._tag}: ${error.message}`)),
    Effect.provide(layerSearch),
  ),
);

search.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
