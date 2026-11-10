import { expect } from "bun:test";
import type { RepoId } from "@stargrep/github/schemas";
import type { SubjectId } from "@stargrep/knowledge/ids";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { facts, model, ref, repoId } from "./fixtures.ts";
import { atom, decide, key, newSubjectId, nextRevision, projectAtoms } from "./knowledge-fixtures.ts";
import { summarize } from "./summaries.ts";

type Services = Db.Db | Db.Transactions | TestDatabase.TestDatabase;

const seed = Effect.fn("seed")(function* (held: ReadonlyMap<RepoId, ReadonlyArray<Db.StoredAtom>>) {
  const db = yield* Db.Db;
  const ids = [...held.keys()];
  yield* db.repos.upsertRefs(ids.map((id) => ref(id)));
  for (const id of ids) {
    yield* db.repos.saveFacts(facts(id));
    yield* summarize({ id, readmeOid: null, summary: "a project", keywords: [] });
  }
  yield* projectAtoms((locked) => held.get(locked.id) ?? [], ids);
  yield* db.knowledge.count;
});

const subjectNamed = Effect.fn("subjectNamed")(function* (
  label: string,
  status: "accepted" | "candidate" | "rejected" = "accepted",
) {
  const id = yield* newSubjectId;
  const revision = yield* nextRevision;
  yield* decide("create", {
    created: [{ id, label, definition: null, status }],
    labelsAdded: [{ key: key(label), subjectId: id, isDefault: true, revision }],
  });
  return id;
});

const subject = (role: Db.StoredAtom["role"], id: SubjectId) => atom(role, { dim: "subject", id });

const cases = (test: { readonly effect: it.Tester<Services> }) => {
  test.effect("a repo's panel shows every atom it holds, its primary kind first, and its kind comes from atoms", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const shared = yield* subjectNamed("terminal ui");
      const lonely = yield* subjectNamed("one repo concept");
      const panel = repoId(9_101);
      const other = repoId(9_102);
      yield* seed(
        new Map([
          [
            panel,
            [
              atom("is", { dim: "kind", id: "plugin" }),
              atom("is", { dim: "kind", id: "library" }),
              atom("written_in", { dim: "language", id: "rust" }),
              atom("licensed", { dim: "license", id: "MIT" }),
              subject("about", shared),
              subject("about", lonely),
            ],
          ],
          [other, [subject("about", shared)]],
        ]),
      );
      yield* database.query("update repos set kind = 'app' where id = $1", [panel]);

      const held = yield* db.facets.held([panel, other]);
      expect(held.get(panel)).toEqual([
        { atom: "kind:plugin", label: "plugin", listed: true, repoId: null },
        { atom: "kind:library", label: "library", listed: true, repoId: null },
        { atom: "written-in:lang:rust", label: "Rust", listed: true, repoId: null },
        { atom: `about:subject:${lonely}`, label: "one repo concept", listed: false, repoId: null },
        { atom: `about:subject:${shared}`, label: "terminal ui", listed: true, repoId: null },
        { atom: "license:MIT", label: "MIT", listed: true, repoId: null },
      ]);
      expect((yield* db.repos.require(panel)).kind).toBe("plugin");
      expect((yield* db.repos.require(other)).kind).toBeNull();
    }),
  );

  test.effect("library atoms are the keys chips count, with listed subjects only and one label each", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const shared = yield* subjectNamed("shared widgets");
      const lonely = yield* subjectNamed("lonely widget");
      const slack = yield* subjectNamed("chat suite");
      const typescript = repoId(9_201);
      const peer = repoId(9_202);
      yield* seed(
        new Map([
          [
            typescript,
            [
              atom("is", { dim: "kind", id: "app" }),
              atom("written_in", { dim: "language", id: "typescript" }),
              atom("built_with", { dim: "platform", id: "node" }),
              subject("about", shared),
              subject("trait", lonely),
              subject("alternative_to", slack),
            ],
          ],
          [peer, [subject("for", shared), subject("alternative_to", slack)]],
        ]),
      );

      const { atoms, labels } = yield* db.facets.matching([typescript, peer]);
      expect(atoms.get(typescript)).toEqual(
        [
          "kind:app",
          "lang:javascript",
          "lang:typescript",
          "with:platform:node",
          `subject:${shared}`,
          `alt:subject:${slack}`,
        ].sort(),
      );
      expect(atoms.get(peer)).toEqual([`alt:subject:${slack}`, `subject:${shared}`]);
      expect(labels).toEqual({
        "kind:app": "app",
        "lang:javascript": "JavaScript",
        "lang:typescript": "TypeScript",
        "with:platform:node": "Node.js",
        [`subject:${shared}`]: "shared widgets",
        [`alt:subject:${slack}`]: "chat suite",
      });
      expect((yield* db.facets.matching([])).atoms.size).toBe(0);
    }),
  );

  test.effect("lookup lists closed values and listed public subjects by a key prefix, most-held first", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const postgres = yield* subjectNamed("PostgreSQL");
      const postgis = yield* subjectNamed("PostGIS");
      const rejected = yield* subjectNamed("postgres noise", "rejected");
      const unlisted = yield* subjectNamed("postgrest");
      const repos = [9_301, 9_302, 9_303].map((n) => repoId(n));
      const [a, b, c] = repos as [RepoId, RepoId, RepoId];
      yield* seed(
        new Map([
          [
            a,
            [subject("for", postgres), subject("for", postgis), subject("about", unlisted), subject("about", rejected)],
          ],
          [b, [subject("for", postgres), subject("for", postgis), subject("about", rejected)]],
          [c, [subject("for", postgres), atom("licensed", { dim: "license", id: "PostgreSQL" })]],
        ]),
      );

      const found = yield* db.facets.lookup({ q: "Postg", limit: 10 });
      const ours = found.filter((facet) => facet.atom.startsWith("subject:") || facet.atom === "license:PostgreSQL");
      expect(ours.map(({ atom, label }) => ({ atom, label }))).toEqual([
        { atom: `subject:${postgres}`, label: "PostgreSQL" },
        { atom: `subject:${postgis}`, label: "PostGIS" },
        { atom: "license:PostgreSQL", label: "PostgreSQL" },
      ]);
      expect(ours[0]?.repos).toBeGreaterThanOrEqual(3);
      expect(found.find((facet) => facet.atom === "license:PostgreSQL")?.repos).toBeGreaterThanOrEqual(1);
      expect(found.map((facet) => facet.atom)).not.toContain(`subject:${unlisted}`);
      expect(found.map((facet) => facet.atom)).not.toContain(`subject:${rejected}`);
      expect(yield* db.facets.lookup({ q: "%", limit: 10 })).toEqual([]);
      expect((yield* db.facets.lookup({ q: "Postg", limit: 1 })).length).toBe(1);
    }),
  );

  test.effect("a merged subject looks up once, as its survivor", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const survivor = yield* subjectNamed("zebra store");
      const merged = yield* subjectNamed("zebra storage");
      yield* seed(
        new Map([
          [repoId(9_401), [subject("about", survivor)]],
          [repoId(9_402), [subject("about", merged)]],
        ]),
      );
      yield* decide("merge", { merged: [{ originId: merged, canonicalId: survivor, revision: yield* nextRevision }] });
      yield* db.knowledge.count;

      expect(yield* db.facets.lookup({ q: "zebra", limit: 10 })).toEqual([
        { atom: `subject:${survivor}`, label: "zebra store", repos: 2 },
      ]);
    }),
  );

  test.effect("a subject one repo holds shows on that repo's panel and in no chip or lookup", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const solo = yield* subjectNamed("quokka solo concept");
      const pair = yield* subjectNamed("quokka pair concept");
      const holder = repoId(9_501);
      const peer = repoId(9_502);
      yield* seed(
        new Map([
          [holder, [subject("about", solo), subject("about", pair)]],
          [peer, [subject("for", pair)]],
        ]),
      );

      const panel = (yield* db.facets.held([holder])).get(holder) ?? [];
      expect(panel.map(({ atom, listed }) => [atom, listed])).toEqual([
        [`about:subject:${pair}`, true],
        [`about:subject:${solo}`, false],
      ]);
      const chips = yield* db.facets.matching([holder, peer]);
      expect([...chips.atoms.values()].flat()).toEqual([`subject:${pair}`, `subject:${pair}`]);
      expect(Object.keys(chips.labels)).toEqual([`subject:${pair}`]);
      expect((yield* db.facets.lookup({ q: "quokka", limit: 10 })).map((facet) => facet.atom)).toEqual([
        `subject:${pair}`,
      ]);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 60_000, testTimeout: 60_000 })(
  "PGlite facets",
  cases,
);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 60_000, testTimeout: 60_000 })(
  "node-postgres facets",
  cases,
);
