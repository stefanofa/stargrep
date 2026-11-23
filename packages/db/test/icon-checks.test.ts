import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { at, model, ref, repoId } from "./fixtures.ts";

const backfill = (url: string) =>
  Effect.promise(async () => {
    const running = Bun.spawn(["bun", "scripts/backfill-icon-checks.ts"], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, DATABASE_URL: url },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      running.exited,
      new Response(running.stdout).text(),
      new Response(running.stderr).text(),
    ]);
    return { exitCode, output: `${stdout}${stderr}` };
  });

it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000, testTimeout: 30_000 })(
  "icon checks",
  (test) => {
    test.effect("backfill-icon-checks copies each old check once, keeps newer checks, and a rerun copies none", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const url = Option.getOrThrow(database.url);
        const [checked, unchecked, rechecked] = [repoId(9101), repoId(9102), repoId(9103)];
        yield* db.repos.upsertRefs([ref(checked), ref(unchecked), ref(rechecked)]);
        yield* db.repos.saveIcon({
          id: checked,
          icon: { key: "v1/git/abc.webp", source: "repo-file", plate: "dark", size: 96 },
        });
        // As before the migration: the checks sit on repos, and only a check since the deploy has a row.
        yield* database.query("delete from repo_icon_checks where repo_id <> $1", [rechecked]);
        yield* database.query("update repos set icon_checked_at = $1 where id = any($2::bigint[])", [
          "2026-10-01T00:00:00Z",
          [checked, rechecked],
        ]);
        yield* db.repos.markIconChecked(rechecked);
        const due = (checkedBefore: string, keyVersion = "v1") =>
          Effect.map(db.repos.dueIcons({ after: 0, limit: 10, checkedBefore: at(checkedBefore), keyVersion }), (rows) =>
            rows.map((row) => row.id),
          );
        expect(yield* due("2026-09-01T00:00:00Z")).toEqual([]);

        const first = yield* backfill(url);
        expect(first.exitCode).toBe(0);
        expect(first.output).toContain("3 repos read, 2 checks written");
        expect(yield* due("2026-09-01T00:00:00Z")).toEqual([unchecked]);
        expect(yield* due("2026-09-01T00:00:00Z", "v2")).toEqual([checked, unchecked]);
        expect(yield* due("2026-10-02T00:00:00Z")).toEqual([checked, unchecked]);
        expect((yield* db.repos.getMany([rechecked]))[0]?.iconCheckedAt).not.toEqual(at("2026-10-01T00:00:00Z"));

        const again = yield* backfill(url);
        expect(again.output).toContain("3 repos read, 0 checks written");
      }),
    );
  },
);
