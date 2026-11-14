import { RepoFacts } from "@stargrep/ai/summarize";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

export const Query = Schema.Struct({
  id: Schema.String,
  category: Schema.String,
  query: Schema.String,
  expected: Schema.Array(Schema.String),
});
export type Query = typeof Query.Type;

export class EvalDataMissing extends Schema.TaggedError<EvalDataMissing>()("EvalDataMissing", { file: Schema.String }) {
  override get message(): string {
    return `cannot read evals/${this.file}${this.file === ".cache/corpus.json" ? ", run `bun run evals/corpus.ts` first" : ""}`;
  }
}

const read = <A>(file: string, decode: (text: string) => Effect.Effect<A, Schema.SchemaError>) =>
  Effect.tryPromise({
    try: () => Bun.file(new URL(`./${file}`, import.meta.url)).text(),
    catch: () => new EvalDataMissing({ file }),
  }).pipe(Effect.flatMap(decode));

const loadQuerySet = (file: string) =>
  read(file, Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Query))));

export const loadQueries = loadQuerySet("queries.json");

export const loadTypos = loadQuerySet("typos.json");

export const loadNonsense = loadQuerySet("nonsense.json");

export const loadDistractors = read(
  "distractors.json",
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String))),
);

const decodeRepos = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(RepoFacts)));

export const loadCorpus = read(".cache/corpus.json", decodeRepos);

const mostStarredFile = ".cache/most-starred.json";

// GitHub's most-starred repos, most stars first, with no README.
export const loadMostStarred = read(mostStarredFile, decodeRepos);

export const expectedRepos = (queries: ReadonlyArray<Query>) =>
  [...new Set(queries.flatMap((query) => query.expected))].sort();

const encodeCorpus = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(RepoFacts)));

const graphqlBatchSize = 25;

const Blob = Schema.optional(Schema.NullOr(Schema.Struct({ text: Schema.optional(Schema.NullOr(Schema.String)) })));

const readmeFields = {
  readme0: "README.md",
  readme1: "readme.md",
  readme2: "Readme.md",
  readme3: "README.rst",
  readme4: "README.markdown",
  readme5: "README",
} as const;

const RepoNode = Schema.Struct({
  nameWithOwner: Schema.String,
  description: Schema.NullOr(Schema.String),
  repositoryTopics: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ topic: Schema.Struct({ name: Schema.String }) })),
  }),
  primaryLanguage: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  readme0: Blob,
  readme1: Blob,
  readme2: Blob,
  readme3: Blob,
  readme4: Blob,
  readme5: Blob,
});

const GraphqlResponse = Schema.Struct({ data: Schema.Record(Schema.String, Schema.NullOr(RepoNode)) });

const fetchRepos = Effect.fn("Corpus.fetchRepos")(function* (repos: ReadonlyArray<string>) {
  const token = yield* Config.Redacted("GITHUB_TOKEN");
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const readmes = Object.entries(readmeFields)
    .map(([alias, file]) => `${alias}: object(expression: "HEAD:${file}") { ... on Blob { text } }`)
    .join(" ");
  const corpus: Array<RepoFacts> = [];
  const problems: Array<string> = [];
  for (let start = 0; start < repos.length; start += graphqlBatchSize) {
    const batch = repos.slice(start, start + graphqlBatchSize);
    const fields = batch.map((fullName, index) => {
      const [owner, name] = fullName.split("/");
      return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner description repositoryTopics(first: 20) { nodes { topic { name } } } primaryLanguage { name } ${readmes} }`;
    });
    const response = yield* HttpClientRequest.post("https://api.github.com/graphql").pipe(
      HttpClientRequest.bearerToken(Redacted.value(token)),
      HttpClientRequest.setHeader("user-agent", "stargrep-evals"),
      HttpClientRequest.bodyJsonUnsafe({ query: `{ ${fields.join("\n")} }` }),
      client.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(GraphqlResponse)),
    );
    for (const [index, fullName] of batch.entries()) {
      const node = response.data[`r${index}`];
      if (node === null || node === undefined) {
        problems.push(`missing ${fullName}`);
        continue;
      }
      if (node.nameWithOwner !== fullName) problems.push(`renamed ${fullName} -> ${node.nameWithOwner}`);
      const readme = [node.readme0, node.readme1, node.readme2, node.readme3, node.readme4, node.readme5]
        .map((blob) => blob?.text)
        .find((text) => typeof text === "string");
      corpus.push({
        fullName,
        description: node.description,
        topics: node.repositoryTopics.nodes.map((topicNode) => topicNode.topic.name),
        language: node.primaryLanguage?.name ?? null,
        readme: readme ?? null,
      });
    }
  }
  return { corpus, problems };
});

const SearchResponse = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Struct({
      repositoryCount: Schema.Finite,
      pageInfo: Schema.Struct({ endCursor: Schema.NullOr(Schema.String), hasNextPage: Schema.Boolean }),
      nodes: Schema.Array(
        Schema.Struct({
          nameWithOwner: Schema.String,
          description: Schema.NullOr(Schema.String),
          stargazerCount: Schema.Finite,
          primaryLanguage: Schema.NullOr(Schema.Struct({ name: Schema.String })),
          repositoryTopics: Schema.Struct({
            nodes: Schema.Array(Schema.Struct({ topic: Schema.Struct({ name: Schema.String }) })),
          }),
        }),
      ),
    }),
  }),
});

const searchPageSize = 100;
const searchLimit = 1_000;
const firstFloor = 50_000;

const searchFields = `repositoryCount pageInfo { endCursor hasNextPage } nodes { ... on Repository { nameWithOwner description stargazerCount primaryLanguage { name } repositoryTopics(first: 20) { nodes { topic { name } } } } }`;

// Search answers at most 1,000 repos per query. So each query covers a star range, the next 15% of stars below the last
// one, and a range holding more than 1,000 repos is read again from the fewest stars it reached. Repos come out most
// stars first.
const fetchMostStarred = Effect.fn("Corpus.fetchMostStarred")(function* (count: number) {
  const token = yield* Config.Redacted("GITHUB_TOKEN");
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const page = (query: string, after: string | null) =>
    HttpClientRequest.post("https://api.github.com/graphql").pipe(
      HttpClientRequest.bearerToken(Redacted.value(token)),
      HttpClientRequest.setHeader("user-agent", "stargrep-evals"),
      HttpClientRequest.bodyJsonUnsafe({
        query: `query ($q: String!, $after: String) { search(query: $q, type: REPOSITORY, first: ${searchPageSize}, after: $after) { ${searchFields} } }`,
        variables: { q: `${query} sort:stars-desc`, after },
      }),
      client.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(SearchResponse)),
      // A page takes about 7 seconds, and now and then one never answers.
      Effect.timeout(Duration.seconds(30)),
      Effect.tapError((error) => Console.log(`  retrying ${query}: ${error.message}`)),
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 10 }),
      // Search allows 30 requests a minute.
      Effect.tap(() => Effect.sleep(Duration.seconds(1))),
      Effect.map((response) => response.data.search),
    );
  const repos = new Map<string, RepoFacts>();
  let ceiling: number | null = null;
  while (repos.size < count) {
    const floor: number = ceiling === null ? firstFloor : Math.max(1, Math.floor(ceiling * 0.85));
    const query = ceiling === null ? `stars:>=${floor}` : `stars:${floor}..${ceiling}`;
    let fewest: number = ceiling ?? floor;
    let total = 0;
    let after: string | null = null;
    for (let read = 0; read < searchLimit && repos.size < count; read += searchPageSize) {
      const result: typeof SearchResponse.Type.data.search = yield* page(query, after);
      total = result.repositoryCount;
      for (const node of result.nodes) {
        if (repos.size === count) break;
        fewest = node.stargazerCount;
        if (repos.has(node.nameWithOwner)) continue;
        repos.set(node.nameWithOwner, {
          fullName: node.nameWithOwner,
          description: node.description,
          topics: node.repositoryTopics.nodes.map((topicNode) => topicNode.topic.name),
          language: node.primaryLanguage?.name ?? null,
          readme: null,
        });
      }
      if (!result.pageInfo.hasNextPage) break;
      after = result.pageInfo.endCursor;
    }
    ceiling = total <= searchLimit ? floor - 1 : fewest === ceiling ? fewest - 1 : fewest;
    yield* Console.log(`  ${repos.size} repos, down to ${fewest} stars`);
  }
  return [...repos.values()];
});

class CorpusProblems extends Schema.TaggedError<CorpusProblems>()("CorpusProblems", { count: Schema.Finite }) {
  override get message(): string {
    return `${this.count} expected repos need fixing in evals/queries.json`;
  }
}

const main = Effect.gen(function* () {
  const repos = expectedRepos([...(yield* loadQueries), ...(yield* loadTypos)]);
  const distractors = (yield* loadDistractors).filter((name) => !repos.includes(name));
  const expected = yield* fetchRepos(repos);
  const extra = yield* fetchRepos(distractors);
  const all = [...expected.corpus, ...extra.corpus];
  const text = yield* encodeCorpus(all);
  yield* Effect.promise(() => Bun.write(new URL("./.cache/corpus.json", import.meta.url), text));
  yield* Console.log(
    `Wrote ${expected.corpus.length} of ${repos.length} expected repos and ${extra.corpus.length} of ${distractors.length} distractors to evals/.cache/corpus.json, ${all.filter((repo) => repo.readme !== null).length} with a README`,
  );
  for (const problem of expected.problems) yield* Console.log(problem);
  if (expected.problems.length > 0) return yield* new CorpusProblems({ count: expected.problems.length });
});

const writeMostStarred = Effect.fn("Corpus.writeMostStarred")(function* (count: number) {
  const repos = yield* fetchMostStarred(count);
  const text = yield* encodeCorpus(repos);
  yield* Effect.promise(() => Bun.write(new URL(`./${mostStarredFile}`, import.meta.url), text));
  yield* Console.log(`Wrote the ${repos.length} most-starred repos to evals/${mostStarredFile}`);
});

const Count = Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0));

const args = Bun.argv.slice(2);
const mostStarredIndex = args.indexOf("--most-starred");

const program = Effect.gen(function* () {
  if (mostStarredIndex === -1) return yield* main;
  yield* writeMostStarred(yield* Schema.decodeEffect(Count)(args[mostStarredIndex + 1] ?? ""));
});

if (import.meta.main) await Effect.runPromise(Effect.provide(program, FetchHttpClient.layer));
