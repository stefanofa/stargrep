import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as UrlParams from "effect/http/UrlParams";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as GitHub from "../src/github.ts";
import { BudgetShare, Login, type Star } from "../src/schemas.ts";
import * as TokenGate from "../src/token-gate.ts";

const CACHE_DIRECTORY = ".cache/etag";

const shareConfig = Config.schema(
  Schema.FiniteFromString.pipe(Schema.decodeTo(BudgetShare)),
  "GITHUB_BUDGET_SHARE",
).pipe(Config.withDefault(BudgetShare.make(0.5)));

interface Logged {
  readonly line: string;
  readonly status: number;
}

const requests: Array<Logged> = [];

const layerLoggedFetch = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const origin = yield* Clock.currentTimeMillis;
    return HttpClient.transformResponse(client, (response) =>
      Effect.gen(function* () {
        const start = (yield* Clock.currentTimeMillis) - origin;
        const result = yield* response;
        const end = (yield* Clock.currentTimeMillis) - origin;
        const url = new URL(result.request.url);
        const page = Option.getOrUndefined(UrlParams.getFirst(result.request.urlParams, "page"));
        requests.push({
          status: result.status,
          line: `${result.request.method} ${url.pathname}${page === undefined ? "" : `?page=${page}`} -> ${result.status} start=${start}ms end=${end}ms remaining=${result.headers["x-ratelimit-remaining"] ?? "?"}`,
        });
        return result;
      }),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

const layerGitHub = Layer.unwrap(
  Effect.gen(function* () {
    const token = yield* Config.Redacted("GITHUB_TOKEN");
    const share = yield* shareConfig;
    return GitHub.layer.pipe(
      Layer.provideMerge(TokenGate.layerMemory({ token, share })),
      Layer.provide(layerLoggedFetch),
      Layer.provide(KeyValueStore.layerFileSystem(CACHE_DIRECTORY)),
    );
  }),
);

const formatStar = (star: Star) => `${DateTime.formatIso(star.starredAt)}  ${star.repo.owner}/${star.repo.name}`;

const listStars = Effect.fn("sample.listStars")(function* (login: Login, keep: number) {
  const github = yield* GitHub.GitHub;
  const result = yield* github.stars(login).pipe(
    Stream.runFold(
      () => ({ count: 0, head: [] as Array<Star> }),
      (state, star) => {
        if (state.head.length < keep) state.head.push(star);
        state.count++;
        return state;
      },
    ),
  );
  yield* Console.log(`stars: ${result.count}`);
  for (const star of result.head.slice(0, 5)) yield* Console.log(`  ${formatStar(star)}`);
  return result.head;
});

const showFacts = Effect.fn("sample.showFacts")(function* (stars: ReadonlyArray<Star>) {
  const github = yield* GitHub.GitHub;
  const facts = yield* github.repoFacts(stars.map((star) => star.repo.nodeId));
  yield* Console.log(`facts: ${facts.length} of ${stars.length} repos`);
  for (const fact of facts) {
    yield* Console.log(
      `  ${fact.owner}/${fact.name} license=${fact.license ?? "null"} readme=${fact.readme === null ? "null" : `${fact.readme.name}@${fact.readme.oid}`}`,
    );
  }
  return facts;
});

const showReadme = Effect.fn("sample.showReadme")(function* (stars: ReadonlyArray<Star>) {
  const github = yield* GitHub.GitHub;
  const facts = yield* github.repoFacts(stars.map((star) => star.repo.nodeId));
  const fact = facts.find((candidate) => candidate.readme !== null);
  if (fact?.readme == null) return yield* Console.log("readme: none of these repos has a README");
  for (const attempt of [1, 2]) {
    const before = requests.length;
    const text = yield* github.readme({ owner: fact.owner, name: fact.name, oid: fact.readme.oid });
    yield* Console.log(
      `readme fetch ${attempt}: ${fact.owner}/${fact.name} ${fact.readme.name} ${text.length} chars, status ${requests.slice(before).map((request) => request.status)}`,
    );
  }
});

const fireParallel = Effect.fn("sample.fireParallel")(function* (login: Login, count: number) {
  const github = yield* GitHub.GitHub;
  const heads = yield* Effect.all(
    Array.from({ length: count }, () => Stream.runHead(github.stars(login))),
    { concurrency: "unbounded" },
  );
  yield* Console.log(`parallel: ${heads.filter(Option.isSome).length} of ${count} calls returned a star`);
});

const summarize = Effect.fn("sample.summarize")(function* (started: number, log: boolean) {
  const budget = yield* (yield* TokenGate.TokenGate).budget;
  for (const [resource, window] of Object.entries(budget.windows)) {
    yield* Console.log(
      `rate limit ${resource}: ${window.remaining}/${window.limit} remaining, resets ${DateTime.formatIso(DateTime.makeUnsafe(window.resetAt))}`,
    );
  }
  const elapsed = (yield* Clock.currentTimeMillis) - started;
  const notModified = requests.filter((request) => request.status === 304).length;
  yield* Console.log(`requests: ${requests.length} (304: ${notModified}) wall: ${elapsed}ms`);
  if (log) for (const request of requests) yield* Console.log(`  ${request.line}`);
});

const sample = Command.make(
  "sample",
  {
    login: Argument.String("login").pipe(Argument.withSchema(Login)),
    facts: Flag.Int("facts").pipe(Flag.withDescription("Fetch repo facts for the first N stars"), Flag.optional),
    readme: Flag.Boolean("readme").pipe(Flag.withDescription("Fetch one README twice"), Flag.withDefault(false)),
    parallel: Flag.Int("parallel").pipe(
      Flag.withDescription("Fire N parallel first-page requests instead of listing"),
      Flag.optional,
    ),
    log: Flag.Boolean("log").pipe(Flag.withDescription("Print every GitHub request"), Flag.withDefault(false)),
  },
  Effect.fn("sample")(function* (input) {
    const started = yield* Clock.currentTimeMillis;
    const run = Option.isSome(input.parallel)
      ? fireParallel(input.login, input.parallel.value)
      : Effect.gen(function* () {
          const head = yield* listStars(
            input.login,
            Math.max(
              10,
              Option.getOrElse(input.facts, () => 0),
            ),
          );
          if (Option.isSome(input.facts)) yield* showFacts(head.slice(0, input.facts.value));
          if (input.readme) yield* showReadme(head.slice(0, 10));
        });
    yield* run.pipe(
      Effect.tapError((error) => Console.log(`failed: ${error._tag}: ${error.message}`)),
      Effect.ensuring(summarize(started, input.log)),
    );
  }, Effect.provide(layerGitHub)),
);

sample.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
