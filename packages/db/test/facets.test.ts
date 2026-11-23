import { expect } from "bun:test";
import type { RepoId } from "@stargrep/github/schemas";
import type { SubjectId } from "@stargrep/knowledge/ids";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Db from "../src/db.ts";
import { atomColumns } from "../src/schema.ts";
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
  yield* db.knowledge.countAtoms;
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

// The keys each repo's repo_matching_keys row holds, held to the rule the triggers keep: every row equals what
// knowledge_matching_keys computes now, and every repo has a row.
const storedKeys = Effect.fn("storedKeys")(function* (ids: ReadonlyArray<RepoId>) {
  const database = yield* TestDatabase.TestDatabase;
  const read = (text: string) =>
    database.query(text, [ids]) as Effect.Effect<
      ReadonlyArray<{ readonly id: number; readonly keys: ReadonlyArray<string> }>,
      never
    >;
  const kept = yield* read(
    "select repo_id::float8 as id, keys from repo_matching_keys where repo_id = any($1::bigint[]) order by repo_id",
  );
  expect(kept).toEqual(
    yield* read("select repo_id::float8 as id, keys from knowledge_matching_keys($1::bigint[]) order by repo_id"),
  );
  expect(kept.map((row) => row.id)).toEqual([...ids].sort((a, b) => a - b));
  return new Map(kept.map((row) => [row.id, row.keys]));
});

const closedColumns = Object.values(atomColumns).flatMap((columns) =>
  Object.entries(columns).flatMap(([dim, column]) => (dim === "subject" ? [] : [column])),
);

const cases = (test: { readonly effect: it.Tester<Services> }) => {
  test.effect("a repo's panel shows every atom it holds, its primary kind first, and its kind comes from atoms", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
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

  test.effect("a replaced-by atom stays stored and reaches no panel or chip, while the other roles still do", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const successor = yield* subjectNamed("wombat next");
      const rival = yield* subjectNamed("wombat rival");
      const topic = yield* subjectNamed("wombat topic");
      const [old, peer] = [repoId(9_801), repoId(9_802)];
      const atoms = [
        subject("about", topic),
        subject("alternative_to", rival),
        subject("replaced_by", successor),
        atom("replaced_by", { dim: "language", id: "rust" }),
      ];
      yield* seed(
        new Map([
          [old, atoms],
          [peer, atoms],
        ]),
      );

      expect(
        yield* database.query("select role from effective_atoms where repo_id = $1 and role = 'replaced_by'", [old]),
      ).toHaveLength(2);
      expect(((yield* db.facets.held([old])).get(old) ?? []).map((facet) => facet.atom)).toEqual([
        `about:subject:${topic}`,
        `alt:subject:${rival}`,
      ]);
      const chips = yield* db.facets.matching([old, peer]);
      expect(chips.atoms.get(old)).toEqual([`alt:subject:${rival}`, `subject:${topic}`]);
      expect(Object.keys(chips.labels).sort()).toEqual([`alt:subject:${rival}`, `subject:${topic}`]);
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

      for (const q of ["zebra", "zebra storag"])
        expect(yield* db.facets.lookup({ q, limit: 10 })).toEqual([
          { atom: `subject:${survivor}`, label: "zebra store", repos: 2 },
        ]);
    }),
  );

  test.effect("lookup never lists a private subject, whatever its count", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      yield* database.query(
        `insert into "user" (id, name, email) values ('okapi-owner', 'Okapi', 'okapi@example.test')`,
      );
      const [created] = (yield* database.query(
        "insert into subjects (owner_id, label, repo_count) values ('okapi-owner', 'okapi notes', 5) returning id::float8 as id",
      )) as ReadonlyArray<{ readonly id: number }>;
      yield* database.query(
        `insert into subject_labels (namespace, key, subject_id, is_default, source)
         values ('user:okapi-owner', 'okapi notes', $1, true, 'minted')`,
        [created?.id],
      );
      expect(yield* db.facets.lookup({ q: "okapi", limit: 10 })).toEqual([]);
    }),
  );

  test.effect("lookup drops a subject rejected after the count listed it", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const quagga = yield* subjectNamed("quagga tools");
      yield* seed(
        new Map([
          [repoId(9_601), [subject("about", quagga)]],
          [repoId(9_602), [subject("about", quagga)]],
        ]),
      );
      expect((yield* db.facets.lookup({ q: "quagga", limit: 10 })).map((facet) => facet.atom)).toEqual([
        `subject:${quagga}`,
      ]);
      yield* decide("status", {
        presented: [{ id: quagga, label: "quagga tools", definition: null, status: "rejected", repoId: null }],
      });
      expect(yield* db.facets.lookup({ q: "quagga", limit: 10 })).toEqual([]);
    }),
  );

  test.effect("the atom count keeps each closed value's repos, with its expansions, and drops a value none holds", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const [first, second] = [repoId(9_701), repoId(9_702)];
      yield* seed(
        new Map([
          [
            first,
            [atom("written_in", { dim: "language", id: "elixir" }), atom("for", { dim: "language", id: "typescript" })],
          ],
          [
            second,
            [
              atom("written_in", { dim: "language", id: "elixir" }),
              atom("built_with", { dim: "language", id: "erlang" }),
            ],
          ],
        ]),
      );
      const stats = () =>
        database.query(
          "select atom, repos from atom_stats where atom in ('lang:elixir', 'lang:erlang', 'with:lang:erlang') order by atom",
        );
      expect(yield* stats()).toEqual([{ atom: "lang:elixir", repos: 2 }]);
      const [widened] = (yield* database.query(
        `select (select repos from atom_stats where atom = 'lang:javascript') as javascript,
           (select repos from atom_stats where atom = 'lang:typescript') as typescript`,
      )) as ReadonlyArray<{ readonly javascript: number; readonly typescript: number }>;
      expect(widened?.javascript).toBeGreaterThanOrEqual(widened?.typescript ?? Number.POSITIVE_INFINITY);
      expect(
        (yield* db.facets.lookup({ q: "elixir", limit: 10 })).find((facet) => facet.atom === "lang:elixir"),
      ).toEqual({
        atom: "lang:elixir",
        label: "Elixir",
        repos: 2,
      });

      yield* projectAtoms(() => [], [first, second]);
      expect(yield* db.knowledge.countAtoms).toBeGreaterThanOrEqual(1);
      expect(yield* stats()).toEqual([]);
      expect(
        (yield* db.facets.lookup({ q: "elixir", limit: 10 })).find((facet) => facet.atom === "lang:elixir")?.repos,
      ).toBe(0);
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

  test.effect("a page's chips are the same from stored keys as from matching_atoms, row or no row", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const shared = yield* subjectNamed("numbat widgets");
      const lonely = yield* subjectNamed("numbat lonely");
      const rival = yield* subjectNamed("numbat rival");
      const successor = yield* subjectNamed("numbat next");
      const [app, peer, bare] = [repoId(9_901), repoId(9_902), repoId(9_903)];
      yield* seed(
        new Map([
          [
            app,
            [
              atom("is", { dim: "kind", id: "app" }),
              atom("written_in", { dim: "language", id: "typescript" }),
              atom("for", { dim: "platform", id: "node" }),
              atom("built_with", { dim: "language", id: "rust" }),
              subject("about", shared),
              subject("trait", lonely),
              subject("built_with", rival),
              subject("alternative_to", rival),
              subject("replaced_by", successor),
            ],
          ],
          [peer, [subject("for", shared), subject("alternative_to", rival), subject("replaced_by", successor)]],
          [bare, []],
        ]),
      );
      const ids = [app, peer, bare];
      const stored = yield* db.facets.matching(ids);
      expect(stored.atoms.get(app)).toEqual(
        [
          "kind:app",
          "lang:javascript",
          "lang:typescript",
          "platform:node",
          "with:lang:rust",
          `subject:${shared}`,
          `with:subject:${rival}`,
          `alt:subject:${rival}`,
        ].sort(),
      );
      expect(stored.atoms.has(bare)).toBe(false);
      expect((yield* storedKeys(ids)).get(app)).toContain(`subject:${lonely}`);

      yield* database.query("delete from repo_matching_keys where repo_id = $1", [peer]);
      expect(yield* db.facets.matching(ids)).toEqual(stored);
      yield* database.query("delete from repo_matching_keys where repo_id = any($1::bigint[])", [ids]);
      expect(yield* db.facets.matching(ids)).toEqual(stored);
      yield* database.query("select knowledge_refresh_matching_keys($1::bigint[])", [ids]);
      yield* storedKeys(ids);
      expect(yield* db.facets.matching(ids)).toEqual(stored);
    }),
  );

  test.effect("every input of a repo's keys rewrites its stored row, and listing applies when a page reads it", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const widget = yield* subjectNamed("dingo widget");
      const gadget = yield* subjectNamed("dingo gadget");
      const rival = yield* subjectNamed("dingo rival");
      const tooling = yield* subjectNamed("dingo tooling");
      const [a, b, c] = [repoId(9_951), repoId(9_952), repoId(9_953)];
      const atomsOf = new Map<RepoId, ReadonlyArray<Db.StoredAtom>>([
        [
          a,
          [
            atom("written_in", { dim: "language", id: "rust" }),
            subject("about", widget),
            subject("alternative_to", rival),
          ],
        ],
        [b, [subject("about", widget), subject("about", gadget), subject("alternative_to", rival)]],
      ]);
      yield* seed(atomsOf);
      const project = (id: RepoId, atoms: ReadonlyArray<Db.StoredAtom>) => {
        atomsOf.set(id, atoms);
        return projectAtoms(() => atoms, [id]);
      };
      const keysOf = Effect.fn("keysOf")(function* (id: RepoId) {
        return (yield* storedKeys([id])).get(id);
      });
      expect(yield* keysOf(a)).toEqual([`alt:subject:${rival}`, "lang:rust", `subject:${widget}`].sort());

      // A new repo gets an empty row with its facets row.
      yield* db.repos.upsertRefs([ref(c)]);
      expect(yield* keysOf(c)).toEqual([]);

      // Projection that changes only closed arrays, then only subjects.
      yield* project(a, [atom("written_in", { dim: "language", id: "go" }), ...(atomsOf.get(a) ?? []).slice(1)]);
      expect(yield* keysOf(a)).toContain("lang:go");
      expect(yield* keysOf(a)).not.toContain("lang:rust");
      yield* project(b, [subject("about", widget), subject("alternative_to", rival)]);
      expect(yield* keysOf(b)).not.toContain(`subject:${gadget}`);

      // Listing is read with the page: a subject one repo holds is stored and shows once a second repo holds it.
      expect((yield* db.facets.matching([a])).atoms.get(a)).not.toContain(`subject:${gadget}`);
      yield* project(a, [...(atomsOf.get(a) ?? []), subject("trait", gadget)]);
      yield* db.knowledge.count;
      expect(yield* keysOf(a)).toContain(`subject:${gadget}`);
      expect((yield* db.facets.matching([a])).atoms.get(a)).not.toContain(`subject:${gadget}`);
      yield* db.repos.saveFacts(facts(c));
      yield* summarize({ id: c, readmeOid: null, summary: "a project", keywords: [] });
      yield* project(c, [subject("about", gadget)]);
      yield* db.knowledge.count;
      expect((yield* db.facets.matching([a])).atoms.get(a)).toContain(`subject:${gadget}`);

      // A merge, a parent, a link, and a rejection each move the keys of the repos holding the subjects they touch.
      yield* decide("merge", { merged: [{ originId: gadget, canonicalId: widget, revision: yield* nextRevision }] });
      expect(yield* keysOf(c)).toEqual([`subject:${widget}`]);
      yield* decide("parent", {
        edgesAdded: [
          { ancestorId: tooling, descendantId: widget, depth: 1, via: "parent", revision: yield* nextRevision },
        ],
      });
      expect(yield* keysOf(c)).toEqual([`subject:${tooling}`, `subject:${widget}`].sort());
      yield* decide("link", {
        presented: [{ id: rival, label: "dingo rival", definition: null, status: "accepted", repoId: a }],
      });
      expect(yield* keysOf(a)).not.toContain(`alt:subject:${rival}`);
      expect(yield* keysOf(b)).toContain(`alt:subject:${rival}`);
      yield* decide("status", {
        presented: [{ id: rival, label: "dingo rival", definition: null, status: "rejected", repoId: a }],
      });
      expect(yield* keysOf(b)).not.toContain(`alt:subject:${rival}`);

      // A repo GitHub stopped serving holds nothing.
      yield* database.query(
        `with gone as (
           update repos set gone_at = now(), ${closedColumns.map((column) => `${column} = '{}'`).join(", ")}
           where id = $1 returning id
         )
         delete from repo_facets where repo_id in (select id from gone)`,
        [a],
      );
      expect(yield* keysOf(a)).toEqual([]);
      yield* storedKeys([a, b, c]);
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
