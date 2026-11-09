import { expect } from "bun:test";
import type { GitHubAccountId, RepoId } from "@stargrep/github/schemas";
import type { AtomRole } from "@stargrep/knowledge/atom";
import { everything } from "@stargrep/knowledge/atom";
import type { SubjectId } from "@stargrep/knowledge/ids";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import {
  account,
  accountId,
  closedGroup,
  embedding,
  facts,
  hybrid,
  model,
  ref,
  repoId,
  selection,
  starred,
  stars,
} from "./fixtures.ts";
import { about, atom, decide, key, newSubjectId, nextRevision, projectAtoms } from "./knowledge-fixtures.ts";
import { summarize } from "./summaries.ts";

type Services = Db.Db | Db.Transactions | TestDatabase.TestDatabase;

interface Seed {
  readonly id: RepoId;
  // How far the repo sits from the query, so every repo is a meaning match and they rank in this order.
  readonly distance: number;
  readonly atoms?: ReadonlyArray<Db.StoredAtom>;
}

const seed = Effect.fn("seed")(function* (owner: GitHubAccountId, repos: ReadonlyArray<Seed>) {
  const db = yield* Db.Db;
  yield* db.accounts.upsert(account(owner));
  yield* db.repos.upsertRefs(repos.map((repo) => ref(repo.id)));
  for (const repo of repos) {
    yield* db.repos.saveFacts(facts(repo.id));
    yield* summarize({ id: repo.id, readmeOid: null, summary: "a project", keywords: [] });
    yield* db.repos.saveEmbedding({
      id: repo.id,
      owner: ref(repo.id).owner,
      name: ref(repo.id).name,
      keywords: [],
      description: null,
      embedding: embedding({ 0: 1, 1: repo.distance }),
      summary: "a project",
      readmeOid: null,
    });
  }
  yield* db.stars.upsert({ accountId: owner, stars: repos.map((repo) => starred(repo.id, "2026-01-01T00:00:00Z")) });
  const held = new Map(repos.map((repo) => [repo.id, repo.atoms ?? []]));
  yield* projectAtoms(
    (locked) => held.get(locked.id) ?? [],
    repos.map((repo) => repo.id),
  );
});

// A subject with its label keys, created by its own decision. The first subject to take a key is its default.
const subjectNamed = Effect.fn("subjectNamed")(function* (
  label: string,
  keys: ReadonlyArray<string>,
  options: { readonly status?: "accepted" | "candidate" | "rejected"; readonly isDefault?: boolean } = {},
) {
  const id = yield* newSubjectId;
  const revision = yield* nextRevision;
  yield* decide("create", {
    created: [{ id, label, definition: null, status: options.status ?? "accepted" }],
    labelsAdded: keys.map((term) => ({
      key: key(term),
      subjectId: id,
      isDefault: options.isDefault ?? true,
      revision,
    })),
  });
  return id;
});

const holds = (role: Db.StoredAtom["role"], id: SubjectId) => atom(role, { dim: "subject", id });

const subjectGroup = (
  mode: Db.GroupMode,
  keys: readonly [string, ...Array<string>],
  roles: readonly [AtomRole, ...Array<AtomRole>] = ["any"],
): Db.SubjectGroup => ({
  _tag: "Subject",
  mode,
  roles,
  keys: [key(keys[0]), ...keys.slice(1).map((term) => key(term))],
});

const search = (owner: GitHubAccountId, atoms: Partial<Db.AtomQuery>, search: Partial<Db.HybridSearch> = {}) =>
  Effect.flatMap(Effect.service(Db.Db), (db) =>
    db.search.hybrid(
      hybrid({
        scope: stars(owner),
        text: "",
        embedding: embedding({ 0: 1 }),
        limit: 10,
        atoms: { explicit: everything, stated: [], ...atoms },
        ...search,
      }),
    ),
  ).pipe(Effect.map(({ hits, resolution }) => ({ ids: hits.map((hit) => hit.repo.id), resolution })));

// The index and anti shapes run when the subject's matches fit in the account's star count, the probe shape when they
// do not or when the nightly count already says they will not. Each must return the same hits.
const everyShape = Effect.fn("everyShape")(function* (owner: GitHubAccountId, atoms: Partial<Db.AtomQuery>) {
  const database = yield* TestDatabase.TestDatabase;
  const runs: Array<ReadonlyArray<RepoId>> = [];
  for (const [starredCount, repoCount] of [
    [1_000, 0],
    [0, 0],
    [1, 0],
    [1_000, 1_000_000],
  ] as const) {
    yield* database.query("update github_accounts set starred_count = $2 where id = $1", [owner, starredCount]);
    yield* database.query("update subjects set repo_count = $1", [repoCount]);
    runs.push((yield* search(owner, atoms)).ids);
  }
  yield* database.query("update subjects set repo_count = 0");
  expect(new Set(runs.map((ids) => ids.join(",")))).toHaveLength(1);
  return runs[0] ?? [];
});

const atomCases = (test: { readonly effect: it.Tester<Services> }) => {
  test.effect("applies a stated subject only when every key names exactly one accepted subject", () =>
    Effect.gen(function* () {
      const owner = accountId(1201);
      const postgres = yield* subjectNamed("PostgreSQL", ["postgres", "postgresql"]);
      const sqlite = yield* subjectNamed("SQLite", ["sqlite"]);
      const mysql = yield* subjectNamed("MySQL", ["mysql"], { status: "candidate" });
      const graphs = yield* subjectNamed("graph databases", ["graph"]);
      yield* subjectNamed("graph theory", ["graph"], { isDefault: false });
      const [pgcli, sqliteUtils, both, mysqlClient, plain, graphLib] = [1, 2, 3, 4, 5, 6].map((n) =>
        repoId(12_010 + n),
      ) as [RepoId, RepoId, RepoId, RepoId, RepoId, RepoId];
      yield* seed(owner, [
        { id: pgcli, distance: 0, atoms: [holds("for", postgres)] },
        { id: sqliteUtils, distance: 0.1, atoms: [holds("for", sqlite)] },
        { id: both, distance: 0.2, atoms: [about(postgres), about(sqlite)] },
        { id: mysqlClient, distance: 0.3, atoms: [holds("for", mysql)] },
        { id: plain, distance: 0.4 },
        { id: graphLib, distance: 0.5, atoms: [about(graphs)] },
      ]);
      const everyone = [pgcli, sqliteUtils, both, mysqlClient, plain, graphLib];

      expect(yield* everyShape(owner, { stated: [subjectGroup("filter", ["postgres"])] })).toEqual([pgcli, both]);
      expect(yield* everyShape(owner, { stated: [subjectGroup("filter", ["postgresql"])] })).toEqual([pgcli, both]);
      expect(yield* everyShape(owner, { stated: [subjectGroup("filter", ["postgres", "sqlite"])] })).toEqual([
        pgcli,
        sqliteUtils,
        both,
      ]);
      expect(
        yield* everyShape(owner, {
          stated: [subjectGroup("filter", ["postgres"]), subjectGroup("filter", ["sqlite"])],
        }),
      ).toEqual([both]);
      // A candidate subject and an ambiguous key leave their groups unapplied, and the search is today's.
      expect(yield* everyShape(owner, { stated: [subjectGroup("filter", ["postgres", "mysql"])] })).toEqual(everyone);
      expect(yield* everyShape(owner, { stated: [subjectGroup("filter", ["graph"])] })).toEqual(everyone);
      expect(
        yield* everyShape(owner, {
          stated: [subjectGroup("filter", ["graph"]), subjectGroup("filter", ["sqlite"])],
        }),
      ).toEqual([sqliteUtils, both]);

      const resolved = yield* search(owner, {
        stated: [
          closedGroup("filter", "lang:rust"),
          subjectGroup("filter", ["sqlite", "postgresql"]),
          subjectGroup("boost", ["graph"]),
        ],
      });
      expect(resolved.resolution).toEqual({
        stated: [[], [sqlite, postgres], null],
        labels: { [postgres]: "PostgreSQL", [sqlite]: "SQLite" },
        unavailable: [],
      });
      expect(resolved.ids).toEqual([]);
    }),
  );

  test.effect("lifts boosted candidates without dropping any, and ignores a boost that did not resolve", () =>
    Effect.gen(function* () {
      const owner = accountId(1202);
      const tui = yield* subjectNamed("TUI", ["tui"]);
      const slack = yield* subjectNamed("Slack", ["slack"]);
      const [near, terminal, mac, rival] = [1, 2, 3, 4].map((n) => repoId(12_020 + n)) as [
        RepoId,
        RepoId,
        RepoId,
        RepoId,
      ];
      yield* seed(owner, [
        { id: near, distance: 0 },
        { id: terminal, distance: 0.3, atoms: [about(tui)] },
        { id: mac, distance: 0.6, atoms: [atom("runs_on", { dim: "platform", id: "macos" })] },
        { id: rival, distance: 0.9, atoms: [holds("alternative_to", slack)] },
      ]);
      const ranked = (stated: ReadonlyArray<Db.StatedGroup>) =>
        search(owner, { stated }).pipe(Effect.map(({ ids }) => ids));

      expect(yield* ranked([])).toEqual([near, terminal, mac, rival]);
      expect(yield* ranked([subjectGroup("boost", ["tui"])])).toEqual([terminal, near, mac, rival]);
      expect(yield* ranked([subjectGroup("boost", ["nothing named this"])])).toEqual([near, terminal, mac, rival]);
      expect(yield* ranked([closedGroup("boost", "platform:macos")])).toEqual([mac, near, terminal, rival]);
      expect(yield* ranked([subjectGroup("boost", ["slack"], ["alternative_to"])])).toEqual([
        rival,
        near,
        terminal,
        mac,
      ]);
      // Two boosts share one rank list, where a repo matching more of them ranks first.
      expect(yield* ranked([subjectGroup("boost", ["tui"]), closedGroup("boost", "platform:macos")])).toEqual([
        terminal,
        mac,
        near,
        rival,
      ]);
    }),
  );

  test.effect("excludes a subject's holders and keeps a repo with no facets row", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const owner = accountId(1203);
      const electron = yield* subjectNamed("Electron", ["electron"]);
      const [builtWith, aboutIt, clean, unprojected] = [1, 2, 3, 4].map((n) => repoId(12_030 + n)) as [
        RepoId,
        RepoId,
        RepoId,
        RepoId,
      ];
      yield* seed(owner, [
        { id: builtWith, distance: 0, atoms: [holds("built_with", electron)] },
        { id: aboutIt, distance: 0.2, atoms: [about(electron)] },
        { id: clean, distance: 0.4 },
        { id: unprojected, distance: 0.6 },
      ]);
      yield* database.query("delete from repo_facets where repo_id = $1", [unprojected]);

      expect(
        yield* everyShape(owner, { stated: [subjectGroup("exclude", ["electron"], ["any", "built_with"])] }),
      ).toEqual([clean, unprojected]);
      expect(yield* everyShape(owner, { stated: [subjectGroup("exclude", ["electron"])] })).toEqual([
        builtWith,
        clean,
        unprojected,
      ]);
      expect(yield* everyShape(owner, { stated: [subjectGroup("filter", ["electron"])] })).toEqual([aboutIt]);
      expect(
        yield* everyShape(owner, {
          stated: [subjectGroup("exclude", ["electron"]), subjectGroup("filter", ["electron"], ["built_with"])],
        }),
      ).toEqual([builtWith]);
    }),
  );

  // A project is never built with itself or its own alternative, so the repo a subject is linked to never matches its
  // with: or alt: atom.
  test.effect("filters by explicit atoms exactly, through merges, and reports unknown and rejected subjects", () =>
    Effect.gen(function* () {
      const owner = accountId(1204);
      const react = yield* subjectNamed("React", ["react"], { status: "candidate" });
      const reactjs = yield* subjectNamed("reactjs", ["reactjs"], { status: "candidate" });
      const tauri = yield* subjectNamed("Tauri", ["tauri"]);
      const mattermost = yield* subjectNamed("Mattermost", ["mattermost"]);
      const noise = yield* subjectNamed("hacktoberfest", ["hacktoberfest"], { status: "rejected" });
      yield* decide("merge", { merged: [{ originId: reactjs, canonicalId: react, revision: yield* nextRevision }] });
      const [forReact, forReactjs, tauriApp, chat, rival, noisy, rusty, tauriItself] = [1, 2, 3, 4, 5, 6, 7, 8].map(
        (n) => repoId(12_040 + n),
      ) as [RepoId, RepoId, RepoId, RepoId, RepoId, RepoId, RepoId, RepoId];
      yield* seed(owner, [
        { id: forReact, distance: 0, atoms: [holds("for", react)] },
        { id: forReactjs, distance: 0.1, atoms: [holds("for", reactjs)] },
        { id: tauriApp, distance: 0.2, atoms: [holds("built_with", tauri)] },
        { id: chat, distance: 0.3, atoms: [holds("alternative_to", mattermost)] },
        { id: rival, distance: 0.4, atoms: [holds("alternative_to", mattermost)] },
        { id: noisy, distance: 0.5, atoms: [holds("trait", noise)] },
        { id: rusty, distance: 0.6, atoms: [atom("written_in", { dim: "language", id: "rust" })] },
        { id: tauriItself, distance: 0.7, atoms: [holds("built_with", tauri)] },
      ]);
      yield* decide("link", {
        presented: [{ id: mattermost, label: "Mattermost", definition: null, status: "accepted", repoId: chat }],
      });
      yield* decide("link", {
        presented: [{ id: tauri, label: "Tauri", definition: null, status: "accepted", repoId: tauriItself }],
      });
      const explicit = (key: string) => everyShape(owner, { explicit: selection(key) });

      expect(yield* explicit(`subject:${react}`)).toEqual([forReact, forReactjs]);
      expect(yield* explicit(`subject:${reactjs}`)).toEqual([forReact, forReactjs]);
      expect(yield* explicit(`subject:${tauri}`)).toEqual([]);
      expect(yield* explicit(`with:subject:${tauri}`)).toEqual([tauriApp]);
      expect(yield* explicit(`alt:subject:${mattermost}`)).toEqual([rival]);
      expect(yield* explicit(`lang:rust|subject:${react}`)).toEqual([forReact, forReactjs, rusty]);
      expect(yield* explicit(`-subject:${react}`)).toEqual([tauriApp, chat, rival, noisy, rusty, tauriItself]);
      expect(yield* explicit(`-lang:rust|subject:${react}`)).toEqual([tauriApp, chat, rival, noisy, tauriItself]);
      expect(yield* explicit(`subject:${react} with:subject:${tauri}`)).toEqual([]);

      const labelled = yield* search(owner, { explicit: selection(`subject:${reactjs} -lang:rust`) });
      expect(labelled.resolution).toEqual({ stated: [], labels: { [reactjs]: "React" }, unavailable: [] });

      const unknown = 999_999_999 as SubjectId;
      const refused = yield* search(owner, { explicit: selection(`subject:${noise}|subject:${unknown} kind:app`) });
      expect([refused.ids, refused.resolution.unavailable]).toEqual([[], [noise, unknown]]);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 60_000, testTimeout: 60_000 })(
  "PGlite atom search",
  atomCases,
);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 60_000, testTimeout: 60_000 })(
  "node-postgres atom search",
  atomCases,
);
