import { expect } from "bun:test";
import type { RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import pg from "pg";
import * as Db from "../src/db.ts";
import { ignoreError } from "../src/node-postgres.ts";
import * as TestDatabase from "./database.ts";
import { account, accountId, at, decodeWaiting, iso, model, ref, repoId, starred } from "./fixtures.ts";

const starCases = (test: { readonly effect: it.Tester<Db.Db | Db.Transactions | TestDatabase.TestDatabase> }) => {
  test.effect("records the newest full snapshot and leaves it alone on an incremental sync", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(102);
      yield* db.accounts.upsert(account(id));
      expect(
        yield* db.stars.applySnapshot({ accountId: id, stars: [], at: at("2026-10-02T00:00:00Z"), complete: true }),
      ).toEqual({
        starred: [],
        unstarred: [],
      });
      yield* db.accounts.recordStarSync({ accountId: id, at: at("2026-10-03T00:00:00Z") });
      expect(
        yield* db.stars.applySnapshot({ accountId: id, stars: [], at: at("2026-10-01T00:00:00Z"), complete: true }),
      ).toEqual({
        starred: [],
        unstarred: [],
      });

      const stored = Option.getOrThrow(yield* db.accounts.get(id));
      expect(iso(stored.starsSyncedAt)).toBe("2026-10-03T00:00:00.000Z");
      expect(iso(stored.starsFullSyncedAt)).toBe("2026-10-02T00:00:00.000Z");

      const missing = accountId(999_998);
      const sync = yield* db.accounts
        .recordStarSync({ accountId: missing, at: at("2026-10-02T00:00:00Z") })
        .pipe(Effect.flip);
      const snapshot = yield* db.stars
        .applySnapshot({ accountId: missing, stars: [], at: at("2026-10-02T00:00:00Z"), complete: true })
        .pipe(Effect.flip);
      expect([sync._tag, snapshot._tag]).toEqual(["AccountNotFound", "AccountNotFound"]);
    }),
  );

  test.effect("keeps the newest sync time when an older run records last", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(105);
      yield* db.accounts.upsert(account(id));
      yield* db.accounts.recordStarSync({ accountId: id, at: at("2026-10-05T00:00:00Z") });
      yield* db.accounts.recordStarSync({ accountId: id, at: at("2026-10-03T00:00:00Z") });

      const stored = Option.getOrThrow(yield* db.accounts.get(id));
      expect(iso(stored.starsSyncedAt)).toBe("2026-10-05T00:00:00.000Z");

      yield* db.accounts.recordStarSync({ accountId: id, at: at("2026-10-06T00:00:00Z") });
      const advanced = Option.getOrThrow(yield* db.accounts.get(id));
      expect(iso(advanced.starsSyncedAt)).toBe("2026-10-06T00:00:00.000Z");
    }),
  );

  test.effect("stores the same star once", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(301);
      const repo = repoId(3001);
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(repo)]);
      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-01-01T00:00:00Z")] });
      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-01-01T00:00:00Z")] });

      expect((yield* db.stars.list(id)).map((star) => star.repoId)).toEqual([repo]);
    }),
  );

  test.effect("rejects a star for an account that does not exist", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const repo = repoId(3101);
      yield* db.repos.upsertRefs([ref(repo)]);

      const error = yield* db.stars
        .upsert({ accountId: accountId(999_997), stars: [starred(repo, "2026-01-01T00:00:00Z")] })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "DbQueryFailed", reason: "constraint", sqlState: "23503" });
    }),
  );

  test.effect("lists active stars newest first", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(302);
      const [old, newest, middle] = [repoId(3201), repoId(3202), repoId(3203)];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(old), ref(newest), ref(middle)]);
      yield* db.stars.upsert({
        accountId: id,
        stars: [
          starred(old, "2026-01-01T00:00:00Z"),
          starred(newest, "2026-03-01T00:00:00Z"),
          starred(middle, "2026-02-01T00:00:00Z"),
        ],
      });

      expect((yield* db.stars.list(id)).map((star) => star.repoId)).toEqual([newest, middle, old]);
    }),
  );

  test.effect("lists a repo GitHub stopped serving as gone, on the library and on a page", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const id = accountId(319);
      const [kept, gone] = [repoId(3191), repoId(3192)];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(kept), ref(gone)]);
      yield* db.stars.upsert({
        accountId: id,
        stars: [starred(kept, "2026-01-01T00:00:00Z"), starred(gone, "2026-02-01T00:00:00Z")],
      });
      yield* database.query(`update repos set gone_at = now() where id = ${gone}`);

      const flags = (entries: ReadonlyArray<Db.LibraryEntry>) => entries.map((entry) => [entry.repo.id, entry.gone]);
      const expected = [
        [gone, true],
        [kept, false],
      ];
      expect(flags(yield* db.stars.library(id))).toEqual(expected);
      expect(flags((yield* db.stars.page(id, { limit: 10, after: Option.none() })).entries)).toEqual(expected);
    }),
  );

  test.effect("describes current stars by language, day, and topic, and counts the archived and unstarred ones", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const [id, other] = [accountId(321), accountId(322)];
      const [go, tsOld, tsNew, unnamed, dropped, elsewhere] = [
        repoId(3211),
        repoId(3212),
        repoId(3213),
        repoId(3214),
        repoId(3215),
        repoId(3216),
      ];
      yield* db.accounts.upsert(account(id));
      yield* db.accounts.upsert(account(other));
      yield* db.repos.upsertRefs([go, tsOld, tsNew, unnamed, dropped, elsewhere].map((repo) => ref(repo)));
      yield* database.query(
        `update repos set language = case when id = ${go} then 'Go' when id = ${unnamed} then null else 'TypeScript' end where id between ${go} and ${elsewhere}`,
      );
      // An archived repo has no topic rows, and only an archived repo GitHub still serves counts as archived.
      yield* database.query(`update repos set topics = '["cli", "tui"]' where id = ${go}`);
      yield* database.query(`update repos set topics = '["cli"]' where id in (${tsOld}, ${tsNew}, ${dropped})`);
      yield* database.query(`update repos set archived = true where id in (${tsNew}, ${unnamed})`);
      yield* database.query(`update repos set gone_at = now() where id = ${unnamed}`);
      const kept = [
        starred(go, "2026-01-01T00:00:00Z"),
        starred(tsOld, "2026-01-02T00:00:00Z"),
        starred(tsNew, "2026-01-02T23:59:00Z"),
        starred(unnamed, "2026-01-04T00:00:00Z"),
      ];
      yield* db.stars.upsert({ accountId: id, stars: [...kept, starred(dropped, "2026-01-05T00:00:00Z")] });
      yield* db.stars.applySnapshot({ accountId: id, stars: kept, at: at("2026-02-01T00:00:00Z"), complete: true });
      yield* db.stars.upsert({ accountId: other, stars: [starred(elsewhere, "2026-01-01T00:00:00Z")] });

      expect(yield* db.stars.languages(id)).toEqual({
        total: 4,
        languages: [
          { language: "TypeScript", count: 2 },
          { language: "Go", count: 1 },
        ],
      });
      expect(yield* db.stars.languages(accountId(999_995))).toEqual({ total: 0, languages: [] });
      expect(yield* db.stars.days(id)).toEqual([
        { day: "2026-01-01", stars: 1 },
        { day: "2026-01-02", stars: 2 },
        { day: "2026-01-04", stars: 1 },
      ]);
      expect(yield* db.stars.topics(id, 5)).toEqual([
        { topic: "cli", count: 2 },
        { topic: "tui", count: 1 },
      ]);
      expect(yield* db.stars.topics(id, 1)).toEqual([{ topic: "cli", count: 2 }]);
      expect(yield* db.stars.churn(id, at("2026-01-15T00:00:00Z"))).toEqual({ archived: 1, unstarred: 1 });
      expect(yield* db.stars.churn(id, at("2026-03-01T00:00:00Z"))).toEqual({ archived: 1, unstarred: 0 });
    }),
  );

  test.effect("pages through active stars newest first, ties by repo ID, with no gap and no repeat", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(305);
      const [newest, tieLow, tieHigh, oldest, gone] = [
        repoId(3502),
        repoId(3503),
        repoId(3504),
        repoId(3505),
        repoId(3506),
      ];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([newest, tieLow, tieHigh, oldest, gone].map((repo) => ref(repo)));
      const kept = [
        starred(oldest, "2026-01-01T00:00:00Z"),
        starred(tieHigh, "2026-02-01T00:00:00Z"),
        starred(tieLow, "2026-02-01T00:00:00Z"),
        starred(newest, "2026-03-01T00:00:00Z"),
      ];
      yield* db.stars.upsert({ accountId: id, stars: [...kept, starred(gone, "2026-04-01T00:00:00Z")] });
      yield* db.stars.applySnapshot({ accountId: id, stars: kept, at: at("2026-05-01T00:00:00Z"), complete: true });

      const pages: Array<ReadonlyArray<RepoId>> = [];
      let after = Option.none<Db.StarsPosition>();
      do {
        const page = yield* db.stars.page(id, { limit: 2, after });
        pages.push(page.entries.map((entry) => entry.repo.id));
        after = page.next;
      } while (Option.isSome(after));
      expect(pages).toEqual([
        [newest, tieLow],
        [tieHigh, oldest],
      ]);

      const whole = yield* db.stars.page(id, { limit: 4, after: Option.none() });
      expect([whole.entries.length, Option.isNone(whole.next)]).toEqual([4, true]);
      expect(whole.entries).toEqual(yield* db.stars.library(id));
      expect(yield* db.stars.page(accountId(999_996), { limit: 2, after: Option.none() })).toEqual({
        entries: [],
        next: Option.none(),
      });

      // Where each later page starts is where a walk through the pages continues, so the pages can load at once.
      for (const size of [1, 2, 3, 4, 5]) {
        const walked: Array<Db.StarsPosition> = [];
        let at = Option.none<Db.StarsPosition>();
        do {
          at = (yield* db.stars.page(id, { limit: size, after: at })).next;
          if (Option.isSome(at)) walked.push(at.value);
        } while (Option.isSome(at));
        expect(yield* db.stars.pageStarts(id, size)).toEqual(walked);
      }
      expect(yield* db.stars.pageStarts(accountId(999_996), 2)).toEqual([]);
    }),
  );

  test.effect("marks stars missing from a full list as unstarred, once", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(303);
      const [kept, gone, alsoGone] = [repoId(3301), repoId(3302), repoId(3303)];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(kept), ref(gone), ref(alsoGone)]);
      yield* db.stars.upsert({
        accountId: id,
        stars: [kept, gone, alsoGone].map((repo) => starred(repo, "2026-01-01T00:00:00Z")),
      });

      const snapshot = {
        accountId: id,
        stars: [starred(kept, "2026-01-01T00:00:00Z")],
        at: at("2026-02-01T00:00:00Z"),
        complete: true,
      };
      const changes = yield* db.stars.applySnapshot(snapshot);
      expect([changes.starred, changes.unstarred.toSorted()]).toEqual([[], [gone, alsoGone]]);
      expect(yield* db.stars.applySnapshot(snapshot)).toEqual({ starred: [], unstarred: [] });
      expect((yield* db.stars.list(id)).map((star) => star.repoId)).toEqual([kept]);
    }),
  );

  test.effect("keeps the stars an incomplete list lacks, and still records the full read", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(306);
      const [listed, unlisted, added] = [repoId(3601), repoId(3602), repoId(3603)];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(listed), ref(unlisted), ref(added)]);
      yield* db.stars.upsert({
        accountId: id,
        stars: [listed, unlisted].map((repo) => starred(repo, "2026-01-01T00:00:00Z")),
      });

      const changes = yield* db.stars.applySnapshot({
        accountId: id,
        stars: [starred(listed, "2026-01-01T00:00:00Z"), starred(added, "2026-01-15T00:00:00Z")],
        at: at("2026-02-01T00:00:00Z"),
        complete: false,
      });

      expect(changes).toEqual({ starred: [added], unstarred: [] });
      expect((yield* db.stars.list(id)).map((star) => star.repoId).toSorted()).toEqual([listed, unlisted, added]);
      expect(iso(Option.getOrThrow(yield* db.accounts.get(id)).starsFullSyncedAt)).toBe("2026-02-01T00:00:00.000Z");
    }),
  );

  test.effect("brings back a star starred again after its unstar, but not a replay of the old star", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(304);
      const repo = repoId(3401);
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(repo)]);
      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-01-01T00:00:00Z")] });
      yield* db.stars.applySnapshot({ accountId: id, stars: [], at: at("2026-02-01T00:00:00Z"), complete: true });

      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-01-01T00:00:00Z")] });
      expect(yield* db.stars.list(id)).toEqual([]);

      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-03-01T00:00:00Z")] });
      const [star] = yield* db.stars.list(id);
      expect(star?.unstarredAt).toBeNull();
      expect(iso(star?.starredAt ?? null)).toBe("2026-03-01T00:00:00.000Z");
    }),
  );

  test.effect("keeps a star unstarred when a star older than the latest snapshot is replayed", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(9201);
      const repo = repoId(9201);
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(repo)]);
      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-10-01T00:00:00Z")] });
      yield* db.stars.applySnapshot({ accountId: id, stars: [], at: at("2026-10-02T00:00:00Z"), complete: true });
      yield* db.stars.applySnapshot({ accountId: id, stars: [], at: at("2026-10-05T00:00:00Z"), complete: true });
      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-10-03T00:00:00Z")] });

      expect(yield* db.stars.list(id)).toEqual([]);
    }),
  );

  test.effect("accepts a star starred before the latest snapshot when it is observed after it", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(9211);
      const [late, restarred] = [repoId(9211), repoId(9212)];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(late), ref(restarred)]);
      yield* db.stars.applySnapshot({
        accountId: id,
        stars: [starred(restarred, "2026-10-01T00:00:00Z")],
        at: at("2026-10-05T00:00:00Z"),
        complete: true,
      });

      const changed = yield* db.stars.upsert({
        accountId: id,
        stars: [
          starred(late, "2026-10-03T00:00:00Z", "2026-10-06T00:00:00Z"),
          starred(restarred, "2026-09-01T00:00:00Z", "2026-10-06T00:00:00Z"),
        ],
      });

      expect(changed.toSorted()).toEqual([late, restarred]);
      expect((yield* db.stars.list(id)).map((star) => [star.repoId, iso(star.starredAt)])).toEqual([
        [late, "2026-10-03T00:00:00.000Z"],
        [restarred, "2026-09-01T00:00:00.000Z"],
      ]);
    }),
  );

  test.effect("drops a star event observed at or before the latest snapshot and reports no change", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(9221);
      const repo = repoId(9221);
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(repo)]);
      yield* db.stars.applySnapshot({ accountId: id, stars: [], at: at("2026-10-05T00:00:00Z"), complete: true });

      expect(
        yield* db.stars.upsert({
          accountId: id,
          stars: [starred(repo, "2026-10-06T00:00:00Z", "2026-10-05T00:00:00Z")],
        }),
      ).toEqual([]);
      expect(yield* db.stars.list(id)).toEqual([]);
    }),
  );

  test.effect("reports only repos whose star changed, not a newer observation of the same star", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(9231);
      const [repo, other] = [repoId(9231), repoId(9232)];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(repo), ref(other)]);
      expect(yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-10-01T00:00:00Z")] })).toEqual([repo]);

      const changed = yield* db.stars.upsert({
        accountId: id,
        stars: [
          starred(repo, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
          starred(other, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"),
        ],
      });
      expect(changed).toEqual([other]);
    }),
  );

  test.effect("ignores a snapshot older than a star", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(9301);
      const repo = repoId(9301);
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(repo)]);
      yield* db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-10-05T00:00:00Z")] });

      expect(
        yield* db.stars.applySnapshot({ accountId: id, stars: [], at: at("2026-10-02T00:00:00Z"), complete: true }),
      ).toEqual({
        starred: [],
        unstarred: [],
      });
      expect((yield* db.stars.list(id)).map((star) => star.repoId)).toEqual([repo]);
    }),
  );

  test.effect("stores every star of a first full snapshot, however old", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(9351);
      const [older, newer, replayed] = [repoId(9351), repoId(9352), repoId(9353)];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(older), ref(newer), ref(replayed)]);

      const changes = yield* db.stars.applySnapshot({
        accountId: id,
        stars: [starred(older, "2020-01-01T00:00:00Z"), starred(newer, "2026-09-01T00:00:00Z")],
        at: at("2026-10-05T00:00:00Z"),
        complete: true,
      });
      yield* db.stars.upsert({ accountId: id, stars: [starred(replayed, "2026-10-01T00:00:00Z")] });

      expect([changes.starred.toSorted(), changes.unstarred]).toEqual([[older, newer], []]);
      expect((yield* db.stars.list(id)).map((star) => star.repoId)).toEqual([newer, older]);
    }),
  );

  test.effect("keeps each repo's newest star when one star event batch repeats a repo", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(9361);
      const [repeated, other] = [repoId(9361), repoId(9362)];
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(repeated), ref(other)]);
      yield* db.stars.upsert({
        accountId: id,
        stars: [
          starred(repeated, "2026-10-03T00:00:00Z"),
          starred(other, "2026-10-02T00:00:00Z"),
          starred(repeated, "2026-10-04T00:00:00Z"),
        ],
      });

      const listed = yield* db.stars.list(id);
      expect(listed.map((star) => [star.repoId, iso(star.starredAt)])).toEqual([
        [repeated, "2026-10-04T00:00:00.000Z"],
        [other, "2026-10-02T00:00:00.000Z"],
      ]);
    }),
  );

  test.effect("keeps each repo's newest star when a full snapshot lists a repo twice", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = accountId(9371);
      const repeated = repoId(9371);
      yield* db.accounts.upsert(account(id));
      yield* db.repos.upsertRefs([ref(repeated)]);

      const changes = yield* db.stars.applySnapshot({
        accountId: id,
        stars: [starred(repeated, "2026-10-03T00:00:00Z"), starred(repeated, "2026-10-04T00:00:00Z")],
        at: at("2026-10-05T00:00:00Z"),
        complete: true,
      });

      expect(changes).toEqual({ starred: [repeated], unstarred: [] });
      expect((yield* db.stars.list(id)).map((star) => [star.repoId, iso(star.starredAt)])).toEqual([
        [repeated, "2026-10-04T00:00:00.000Z"],
      ]);
    }),
  );

  test.effect("prefers the API star over the archive star at the same time, in either order", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const [viaUpsert, viaSnapshot] = [accountId(9381), accountId(9382)];
      const [apiFirst, archiveFirst] = [repoId(9381), repoId(9382)];
      const sameTime = at("2026-10-03T00:00:00Z");
      const both = (repo: RepoId, first: "api" | "gharchive", second: "api" | "gharchive") => [
        { repoId: repo, starredAt: sameTime, observedAt: sameTime, source: first },
        { repoId: repo, starredAt: sameTime, observedAt: sameTime, source: second },
      ];
      const repeated = [...both(apiFirst, "api", "gharchive"), ...both(archiveFirst, "gharchive", "api")];
      yield* db.accounts.upsert(account(viaUpsert));
      yield* db.accounts.upsert(account(viaSnapshot));
      yield* db.repos.upsertRefs([ref(apiFirst), ref(archiveFirst)]);

      yield* db.stars.upsert({ accountId: viaUpsert, stars: repeated });
      yield* db.stars.applySnapshot({
        accountId: viaSnapshot,
        stars: repeated,
        at: at("2026-10-05T00:00:00Z"),
        complete: true,
      });

      for (const id of [viaUpsert, viaSnapshot]) {
        expect((yield* db.stars.list(id)).map((star) => [star.repoId, star.source])).toEqual([
          [apiFirst, "api"],
          [archiveFirst, "api"],
        ]);
      }
    }),
  );

  test.effect(
    "keeps each repo's synced stargazer count equal to its current stars through every kind of star write",
    () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const [ada, grace, linus] = [accountId(311), accountId(312), accountId(313)];
        const [kept, dropped, restarred, raw] = [repoId(3111), repoId(3112), repoId(3113), repoId(3114)];
        const repos = [kept, dropped, restarred, raw];
        for (const id of [ada, grace, linus]) yield* db.accounts.upsert(account(id));
        yield* db.repos.upsertRefs(repos.map((id) => ref(id)));
        const counts = database
          .query(
            `select r.id::int as id, r.synced_stargazers as stored,
             (select count(*)::int from stars s where s.repo_id = r.id and s.unstarred_at is null) as current
           from repos r where r.id = any($1::bigint[]) order by r.id`,
            [repos],
          )
          .pipe(Effect.map((rows) => rows as ReadonlyArray<{ id: number; stored: number; current: number }>));
        const expectCounts = Effect.fn(function* (expected: Array<number>) {
          const rows = yield* counts;
          expect(rows.map((row) => row.stored)).toEqual(rows.map((row) => row.current));
          expect(rows.map((row) => row.stored)).toEqual(expected);
        });

        const page = (id: typeof ada, time: string, starredRepos: ReadonlyArray<RepoId>) =>
          db.stars.upsert({ accountId: id, stars: starredRepos.map((repo) => starred(repo, time)) });
        yield* page(ada, "2026-01-01T00:00:00Z", [kept, dropped, restarred]);
        yield* page(grace, "2026-01-01T00:00:00Z", [kept, dropped]);
        yield* page(ada, "2026-01-01T00:00:00Z", [kept, dropped, restarred]);
        yield* expectCounts([2, 2, 1, 0]);

        yield* db.stars.applySnapshot({
          accountId: ada,
          stars: [kept].map((repo) => ({ repoId: repo, starredAt: at("2026-01-01T00:00:00Z"), source: "api" })),
          at: at("2026-02-01T00:00:00Z"),
          complete: true,
        });
        yield* expectCounts([2, 1, 0, 0]);

        yield* page(ada, "2026-03-01T00:00:00Z", [restarred]);
        yield* database.query(
          "insert into stars (account_id, repo_id, starred_at, observed_at, source) values ($1, $2, now(), now(), 'api')",
          [linus, raw],
        );
        yield* expectCounts([2, 1, 1, 1]);

        yield* database.query("delete from stars where account_id = $1 and repo_id = $2", [grace, dropped]);
        yield* database.query("delete from github_accounts where id = $1", [linus]);
        yield* expectCounts([2, 0, 1, 0]);
      }),
  );

  test.effect("does nothing for an empty star upsert, even for an unknown account", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const result = yield* db.stars.upsert({ accountId: accountId(999_996), stars: [] }).pipe(Effect.exit);
      expect(Exit.isSuccess(result)).toBe(true);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000 })("PGlite stars", starCases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000 })(
  "node-postgres stars",
  (test) => {
    starCases(test);

    test.effect("keeps a star event that read an older snapshot time from outliving a newer snapshot", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const id = accountId(9801);
        const repo = repoId(9801);
        yield* db.accounts.upsert(account(id));
        yield* db.repos.upsertRefs([ref(repo)]);
        const blocker = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const client = new pg.Client({ connectionString: Option.getOrThrow(database.url) });
            client.on("error", ignoreError);
            await client.connect();
            return client;
          }),
          (client) => Effect.promise(() => client.end()),
        );
        const lockWaits = database
          .query(
            "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
          )
          .pipe(
            Effect.flatMap(decodeWaiting),
            Effect.map((rows) => rows[0]?.waiting ?? 0),
          );
        const until = <E>(ready: Effect.Effect<boolean, E>) =>
          ready.pipe(Effect.repeat({ until: (done) => done, times: 5000 }));

        yield* Effect.promise(() => blocker.query("begin"));
        yield* Effect.promise(() =>
          blocker.query(
            "insert into stars (account_id, repo_id, starred_at, observed_at, source) values ($1, $2, $3, $3, 'api')",
            [id, repo, "2026-09-01T00:00:00Z"],
          ),
        );
        const event = yield* Effect.forkChild(
          db.stars.upsert({ accountId: id, stars: [starred(repo, "2026-10-03T00:00:00Z")] }),
        );
        yield* until(Effect.map(lockWaits, (waiting) => waiting >= 1));
        const snapshot = yield* Effect.forkChild(
          db.stars.applySnapshot({ accountId: id, stars: [], at: at("2026-10-05T00:00:00Z"), complete: true }),
        );
        yield* until(Effect.map(lockWaits, (waiting) => waiting >= 2 || snapshot.pollUnsafe() !== undefined));
        yield* Effect.promise(() => blocker.query("rollback"));
        yield* Fiber.join(event);
        yield* Fiber.join(snapshot);

        expect(yield* db.stars.list(id)).toEqual([]);
      }),
    );

    test.effect("counts both of two syncs that star one repo at once", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const [first, second] = [accountId(9811), accountId(9812)];
        const repo = repoId(9811);
        for (const id of [first, second]) yield* db.accounts.upsert(account(id));
        yield* db.repos.upsertRefs([ref(repo)]);
        const other = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const client = new pg.Client({ connectionString: Option.getOrThrow(database.url) });
            client.on("error", ignoreError);
            await client.connect();
            return client;
          }),
          (client) => Effect.promise(() => client.end()),
        );
        const waiting = database
          .query(
            "select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
          )
          .pipe(
            Effect.flatMap(decodeWaiting),
            Effect.map((rows) => rows[0]?.waiting ?? 0),
          );

        yield* Effect.promise(() => other.query("begin"));
        yield* Effect.promise(() =>
          other.query(
            "insert into stars (account_id, repo_id, starred_at, observed_at, source) values ($1, $2, $3, $3, 'api')",
            [first, repo, "2026-09-01T00:00:00Z"],
          ),
        );
        const starring = yield* Effect.forkChild(
          db.stars.upsert({ accountId: second, stars: [starred(repo, "2026-09-02T00:00:00Z")] }),
        );
        yield* waiting.pipe(Effect.repeat({ until: (count) => count >= 1, times: 5000 }));
        yield* Effect.promise(() => other.query("commit"));
        yield* Fiber.join(starring);

        expect(yield* database.query("select synced_stargazers as count from repos where id = $1", [repo])).toEqual([
          { count: 2 },
        ]);
      }),
    );
  },
);
