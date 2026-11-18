import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import { drizzle } from "drizzle-orm/node-postgres";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodePostgres from "../src/node-postgres.ts";
import * as Postgres from "../src/postgres.ts";
import * as Repos from "../src/queries/repos.ts";
import * as TestDatabase from "./database.ts";
import { at, model, repoId } from "./fixtures.ts";

interface Rendered {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
}

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Parent Relationship"?: string;
  readonly Plans?: ReadonlyArray<PlanNode>;
}

// The statement a query function sends first, rendered by its own code rather than copied, so a change to its order or
// its filter reaches this test.
const statementOf = <E>(use: (repos: Repos.Queries) => Effect.Effect<unknown, E>) =>
  Effect.gen(function* () {
    const statements: Array<Rendered> = [];
    const capture = Postgres.Postgres.of({
      run: (_operation, query) =>
        Effect.sync(() => {
          statements.push((query(drizzle.mock()) as unknown as { readonly toSQL: () => Rendered }).toSQL());
          return [] as never;
        }),
      withTransaction: (effect) => effect,
      withLongTimeout: (effect) => effect,
    });
    const repos = yield* Repos.make(model).pipe(
      Effect.provideService(Postgres.Postgres, capture),
      Effect.provide(Digest.layerWebCrypto),
    );
    yield* Effect.ignore(use(repos));
    const [first] = statements;
    if (first === undefined) return yield* Effect.die(new Error("the query sent no statement"));
    return first;
  });

const nodes = (node: PlanNode): ReadonlyArray<PlanNode> => [node, ...(node.Plans ?? []).flatMap(nodes)];
const subPlans = (plan: PlanNode) =>
  nodes(plan).flatMap((node) => (node["Parent Relationship"] === "SubPlan" ? [node["Node Type"]] : []));

it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })(
  "summary order plans",
  (test) => {
    // With sorts and full scans priced out, Postgres still sorts when no index yields the order, so a plan with no Sort
    // node shows an index serves it at any size. The sweep then reads about as many rows as it sends, however many wait.
    const planOf = Effect.fn(function* (statement: Rendered) {
      const database = yield* TestDatabase.TestDatabase;
      const pool = yield* NodePostgres.acquirePool(Option.getOrThrow(database.url));
      return yield* Effect.acquireUseRelease(
        Effect.promise(() => pool.connect()),
        (client) =>
          Effect.promise(async () => {
            for (const setting of ["enable_sort", "enable_incremental_sort", "enable_seqscan", "enable_bitmapscan"]) {
              await client.query(`set ${setting} = off`);
            }
            const { rows } = await client.query(`explain (format json) ${statement.sql}`, [...statement.params]);
            return rows[0]["QUERY PLAN"][0].Plan as PlanNode;
          }),
        (client) => Effect.sync(() => client.release(true)),
      );
    });

    const expectIndexOrder = (plan: PlanNode) => {
      const all = nodes(plan);
      expect(all.map((node) => node["Node Type"]).filter((type) => type.includes("Sort"))).toEqual([]);
      expect(subPlans(plan)).toEqual([]);
      expect(all.filter((node) => node["Relation Name"] === "repos").map((node) => node["Node Type"])).toEqual([
        "Index Scan",
      ]);
    };

    test.effect("sends the sweep's repos in summary order straight from an index", () =>
      Effect.gen(function* () {
        const statement = yield* statementOf((repos) =>
          repos.sweepable({ now: at("2026-05-01T00:00:00Z"), limit: 100 }),
        );
        expectIndexOrder(yield* planOf(statement));
      }),
    );

    test.effect("lists the prefill's pending summaries in summary order straight from an index", () =>
      Effect.gen(function* () {
        const statement = yield* statementOf((repos) =>
          repos.pendingSummaries({ now: at("2026-05-01T00:00:00Z"), limit: 1000 }),
        );
        expectIndexOrder(yield* planOf(statement));
      }),
    );

    test.effect("ranks a leased chunk without counting stargazers row by row", () =>
      Effect.gen(function* () {
        const statement = yield* statementOf((repos) => repos.inSummaryOrder([repoId(1), repoId(2), repoId(3)]));
        const plan = yield* planOf(statement);
        expect(subPlans(plan)).toEqual([]);
      }),
    );
  },
);
