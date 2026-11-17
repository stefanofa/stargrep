import { expect } from "bun:test";
import { summaryRecipe } from "@stargrep/ai/models";
import * as it from "@stargrep/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { model, repoId } from "./fixtures.ts";

const first = "00000000-0000-4000-8000-0000000071aa";
const second = "00000000-0000-4000-8000-0000000071bb";
const stale = Duration.minutes(1);

const query = (text: string) =>
  Effect.flatMap(Effect.service(TestDatabase.TestDatabase), (database) => database.query(text));

const age = (seconds: number) =>
  Effect.flatMap(Effect.service(TestDatabase.TestDatabase), (database) =>
    database.query(`update star_import_owner set heartbeat_at = now() - interval '${seconds} seconds'`),
  );

const cases = (test: { readonly effect: it.Tester<Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("lets one driver hold the import until its heartbeat, on the database's clock, goes stale", () =>
    Effect.gen(function* () {
      const { starImports } = yield* Db.Db;
      expect(yield* starImports.claim({ owner: first, stale })).toBe(true);
      expect(yield* starImports.claim({ owner: first, stale })).toBe(true);
      expect(yield* starImports.claim({ owner: second, stale })).toBe(false);
      yield* age(50);
      expect(yield* starImports.claim({ owner: second, stale })).toBe(false);
      expect(yield* starImports.heartbeat(first)).toBe(true);
      yield* age(90);
      expect(yield* starImports.claim({ owner: second, stale })).toBe(true);
      expect(yield* starImports.heartbeat(first)).toBe(false);
      yield* starImports.release(first);
      expect(yield* starImports.heartbeat(second)).toBe(true);
      yield* starImports.release(second);
      expect(yield* starImports.claim({ owner: first, stale })).toBe(true);
      yield* starImports.release(first);
    }),
  );

  test.effect("lists the repos that wait for a summary and have enough stars, with their star counts", () =>
    Effect.gen(function* () {
      const { repos } = yield* Db.Db;
      yield* query(
        "insert into repos (id, owner, name) select id, 'owner', 'repo-' || id from generate_series(7201, 7208) as id",
      );
      yield* query(
        "insert into repo_metrics (repo_id, stars, refreshed_at) select id, case when id = 7202 then 199 else 200 + id - 7201 end, now() from generate_series(7201, 7207) as id",
      );
      yield* query("update repos set summary = 'current' where id = 7203");
      yield* query(`update repos set summary = 'older', summary_recipe = ${summaryRecipe - 1} where id = 7204`);
      yield* query("update repos set gone_at = now() where id = 7205");
      yield* query("update repos set enrich_failures = 3 where id = 7206");

      const ids = [7201, 7202, 7203, 7204, 7205, 7206, 7207, 7208].map((id) => repoId(id));
      const found = yield* repos.summaryCandidates({ ids, minStars: 200 });
      expect(found.map((repo) => [repo.id, `${repo.owner}/${repo.name}`, repo.stars]).toSorted()).toEqual([
        [7201, "owner/repo-7201", 200],
        [7204, "owner/repo-7204", 203],
        [7207, "owner/repo-7207", 206],
      ]);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite star import owner", cases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })(
  "node-postgres star import owner",
  cases,
);
