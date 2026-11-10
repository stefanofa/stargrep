import { expect } from "bun:test";
import type { RepoId } from "@stargrep/github/schemas";
import type { SubjectId } from "@stargrep/knowledge/ids";
import type { LabelKey } from "@stargrep/knowledge/label-key";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { model } from "./fixtures.ts";
import {
  about,
  answer,
  atom,
  claim,
  createSubject,
  decide,
  key,
  newSubjectId,
  nextRevision,
  projectAtoms,
  receiptId,
  seedRepo,
} from "./knowledge-fixtures.ts";

type Services = Db.Db | Db.Transactions | TestDatabase.TestDatabase;

const labelsOf = Effect.fn("labelsOf")(function* (ids: ReadonlyArray<number>) {
  const database = yield* TestDatabase.TestDatabase;
  const rows = yield* database.query("select id::float8 as id, label from subjects where id = any($1::bigint[])", [
    ids,
  ]);
  return new Map(rows.map((row) => [(row as { id: number }).id, (row as { label: string }).label]));
});

const orderCases = (test: { readonly effect: it.Tester<Services> }) => {
  // opus's fixture from the interrogation: a repo's atoms must not depend on which repos were projected first. Keywords
  // play about claims, a claim mints only when its term occurs in the repo's name, description, or topics, and a topic
  // becomes tagged only when its key already has a label.
  test.effect("projects opus's three repos to one result in all six orders, each followed by the stale sweep", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const permutations = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
      ] as const;
      const outcomes: Array<ReadonlyArray<ReadonlyArray<string>>> = [];
      for (const [run, order] of permutations.entries()) {
        const tag = "abcdef"[run] ?? "z";
        const protocol = `acme widget protocol ${tag}`;
        const capability = `unsignalled capability ${tag}`;
        const fixture = [
          { description: "A useful tool", topics: [protocol], keywords: [] },
          { description: "Another useful tool", topics: [], keywords: [capability] },
          { description: `Implements ${protocol} with ${capability}`, topics: [], keywords: [protocol, capability] },
        ];
        const ids: Array<RepoId> = [];
        const claims = new Map<RepoId, ReadonlyArray<{ readonly term: string; readonly mints: boolean }>>();
        for (const [index, repo] of fixture.entries()) {
          const id = yield* seedRepo({
            id: 72_000 + run * 10 + index,
            description: repo.description,
            topics: repo.topics,
          });
          const input = `probe/repo-${id} ${repo.description} ${repo.topics.join(" ")}`.toLowerCase();
          const terms = repo.keywords.map((term) => ({ term, mints: input.includes(term) }));
          claims.set(id, terms);
          yield* db.knowledge.capture([
            answer(id, receiptId(id), { claims: terms.map(({ term }, ordinal) => claim("about", term, { ordinal })) }),
          ]);
          ids.push(id);
        }
        // The stand-in for projection's two steps: mint what a minting claim needs, then project from the labels.
        const projectOne = (id: RepoId) =>
          Effect.gen(function* () {
            yield* db.knowledge.mint(
              (claims.get(id) ?? [])
                .filter((claim) => claim.mints)
                .map(({ term }) => ({
                  key: key(term),
                  label: term,
                  receiptId: receiptId(id),
                })),
            );
            yield* db.knowledge.project([id], (locked) =>
              Effect.forEach(locked, (repo) =>
                Effect.gen(function* () {
                  const claimed = repo.claims.map((stored) => stored.key);
                  const topics = repo.topics.map(key);
                  const labels = yield* db.knowledge.labels([...claimed, ...topics]);
                  const resolve = (wanted: LabelKey) =>
                    labels.find((label) => label.key === wanted && label.isDefault)?.subjectId;
                  const resolved = (keys: ReadonlyArray<LabelKey>) =>
                    keys.flatMap((wanted) => {
                      const id = resolve(wanted);
                      return id === undefined ? [] : [id];
                    });
                  return {
                    repoId: repo.id,
                    receiptId: repo.receiptId,
                    atoms: [
                      ...resolved(claimed).map(about),
                      ...resolved(topics).map((id) => atom("tagged", { dim: "subject", id })),
                    ],
                    unresolvedKeys: [...claimed, ...topics].filter((wanted) => resolve(wanted) === undefined),
                    verdicts: [],
                  };
                }),
              ).pipe(Effect.map((write) => ({ write, carry: undefined }))),
            );
          });
        for (const position of order) yield* projectOne(ids[position] ?? ids[0] ?? (0 as RepoId));
        for (let pass = 0; pass < 5; pass++) {
          const stale = (yield* db.knowledge.stale(100_000)).filter((id) => ids.includes(id));
          if (stale.length === 0) break;
          yield* Effect.forEach(stale, projectOne, { discard: true });
        }
        const database = yield* TestDatabase.TestDatabase;
        const rows = yield* database.query(
          `select repo_id::float8 as id, about::float8[] as about, tagged::float8[] as tagged, stale
           from repo_facets where repo_id = any($1::bigint[]) order by repo_id`,
          [ids],
        );
        const typed = rows as ReadonlyArray<{ about: Array<number>; tagged: Array<number>; stale: boolean }>;
        const labels = yield* labelsOf(typed.flatMap((row) => [...row.about, ...row.tagged]));
        const plain = (id: number) => (labels.get(id) ?? "?").slice(0, -` ${tag}`.length);
        expect(typed.every((row) => !row.stale)).toBe(true);
        outcomes.push(
          typed.map((row) =>
            [...row.about.map((id) => `about:${plain(id)}`), ...row.tagged.map((id) => `tagged:${plain(id)}`)].sort(),
          ),
        );
      }
      const expected = [
        ["tagged:acme widget protocol"],
        ["about:unsignalled capability"],
        ["about:acme widget protocol", "about:unsignalled capability"],
      ];
      expect(outcomes).toEqual(permutations.map(() => expected));
    }),
  );
};

const listingCases = (test: { readonly effect: it.Tester<Services> }) => {
  // Revision 3's listing: a subject is listed once a second distinct repo holds it, and the nightly count reads
  // matching_atoms, so it follows merges, parents, rejection, the self rule, comparisons, built_with, and the tombstone.
  test.effect("lists a subject once two repos hold it, through every rule a filter follows", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const tui = yield* createSubject("terminal user interfaces");
      const reactjs = yield* createSubject("reactjs");
      const react = yield* createSubject("react");
      const slack = yield* createSubject("Slack");
      const databases = yield* createSubject("databases");
      const vectors = yield* createSubject("vector databases");
      const noise = yield* createSubject("hacktoberfest");
      const mattermost = yield* createSubject("mattermost");
      const tauri = yield* createSubject("tauri");
      const repos: Array<RepoId> = [];
      for (let n = 1; n <= 12; n++) repos.push(yield* seedRepo({ id: 73_000 + n }));
      const repo = (n: number) => repos[n - 1] ?? (0 as RepoId);
      yield* decide("merge", { merged: [{ originId: reactjs, canonicalId: react, revision: yield* nextRevision }] });
      yield* decide("parent", {
        edgesAdded: [
          { ancestorId: databases, descendantId: vectors, depth: 1, via: "parent", revision: yield* nextRevision },
        ],
      });
      yield* decide("link", {
        presented: [{ id: mattermost, label: "mattermost", definition: null, status: "accepted", repoId: repo(9) }],
      });
      const subjectAtom = (role: Db.StoredAtom["role"], id: SubjectId) => atom(role, { dim: "subject", id });
      const held = new Map<RepoId, ReadonlyArray<Db.StoredAtom>>([
        [repo(1), [about(tui)]],
        [repo(2), [subjectAtom("for", reactjs)]],
        [repo(3), [subjectAtom("for", react)]],
        [repo(4), [subjectAtom("alternative_to", slack)]],
        [repo(7), [subjectAtom("alternative_to", slack)]],
        [repo(5), [about(vectors)]],
        [repo(6), [about(vectors)]],
        [repo(8), [subjectAtom("trait", noise)]],
        [repo(9), [subjectAtom("alternative_to", mattermost)]],
        [repo(10), [subjectAtom("trait", noise), subjectAtom("alternative_to", mattermost)]],
        [repo(11), [subjectAtom("built_with", tauri)]],
        [repo(12), [subjectAtom("built_with", tauri)]],
      ]);
      yield* projectAtoms((locked) => held.get(locked.id) ?? [], repos);
      const listing = Effect.gen(function* () {
        yield* db.knowledge.count;
        const rows = yield* database.query(
          "select id::float8 as id, repo_count as count, listed from subjects where id = any($1::bigint[])",
          [[tui, reactjs, react, slack, databases, vectors, noise, mattermost, tauri]],
        );
        const typed = rows as ReadonlyArray<{ id: number; count: number; listed: boolean }>;
        return new Map(typed.map((row) => [row.id, row]));
      });
      const first = yield* listing;
      expect(first.get(tui)).toEqual({ id: tui, count: 1, listed: false });
      expect(first.get(reactjs)).toEqual({ id: reactjs, count: 0, listed: false });
      expect(first.get(react)).toEqual({ id: react, count: 2, listed: true });
      expect(first.get(slack)).toEqual({ id: slack, count: 2, listed: true });
      expect(first.get(databases)).toEqual({ id: databases, count: 2, listed: true });
      expect(first.get(vectors)).toEqual({ id: vectors, count: 2, listed: true });
      expect(first.get(noise)).toEqual({ id: noise, count: 2, listed: true });
      expect(first.get(mattermost)).toEqual({ id: mattermost, count: 1, listed: false });
      expect(first.get(tauri)).toEqual({ id: tauri, count: 2, listed: true });
      const atomsOn = (n: number, listed: boolean) =>
        database.query("select atom from matching_atoms where repo_id = $1 and listed = $2 order by atom", [
          repo(n),
          listed,
        ]);
      expect(yield* atomsOn(1, false)).toEqual([{ atom: `about:subject:${tui}` }, { atom: `subject:${tui}` }]);
      expect(yield* atomsOn(3, true)).toEqual([{ atom: `for:subject:${react}` }, { atom: `subject:${react}` }]);

      held.set(repo(2), [subjectAtom("for", reactjs), about(tui)]);
      yield* projectAtoms((locked) => held.get(locked.id) ?? [], [repo(2)]);
      expect((yield* listing).get(tui)?.listed).toBe(true);

      yield* decide("status", {
        presented: [{ id: noise, label: "hacktoberfest", definition: null, status: "rejected", repoId: null }],
      });
      expect((yield* listing).get(noise)).toEqual({ id: noise, count: 0, listed: false });

      yield* database.query(
        `with gone as (update repos set gone_at = now() where id = $1 returning id)
         delete from repo_facets where repo_id in (select id from gone)`,
        [repo(2)],
      );
      expect((yield* listing).get(tui)).toEqual({ id: tui, count: 1, listed: false });
    }),
  );
};

const deletionCases = (test: { readonly effect: it.Tester<Services> }) => {
  // opus 9 and sol 5: deleting a user leaves nothing private behind, and no merge or edge crosses namespaces.
  test.effect("deleting a user deletes their private vocabulary and curation log, and nothing crosses namespaces", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const [billing, service, exports, payroll, privateOne] = [
        yield* newSubjectId,
        yield* newSubjectId,
        yield* newSubjectId,
        yield* newSubjectId,
        yield* newSubjectId,
      ];
      yield* database.query(`insert into "user" (id, name, email) values
        ('pr2-u1', 'Pro user', 'pr2-u1@example.com'), ('pr2-u3', 'Pro user 3', 'pr2-u3@example.com'),
        ('pr2-u4', 'Pro user 4', 'pr2-u4@example.com')`);
      yield* database.query(`insert into decisions (owner_id, revision, kind, payload, actor, reason) values
        ('pr2-u1', 1, 'merge', '{"_tag":"Merge"}', 'u1', 'same internal tool'),
        ('pr2-u1', 2, 'split', '{"_tag":"Split"}', 'u1', 'narrower sense')`);
      yield* database.query(
        `insert into subjects (id, owner_id, label) values
           ($1, 'pr2-u1', 'acme-billing'), ($2, 'pr2-u1', 'acme billing service'), ($3, 'pr2-u1', 'acme billing exports')`,
        [billing, service, exports],
      );
      yield* database.query(
        `insert into subject_labels (namespace, key, subject_id, is_default, source) values
           ('user:pr2-u1', 'acme billing', $1, true, 'minted'), ('user:pr2-u1', 'acme billing service', $2, true, 'minted')`,
        [billing, service],
      );
      yield* database.query(
        "insert into subject_canonical (namespace, origin_id, canonical_id, revision) values ('user:pr2-u1', $1, $2, 1)",
        [billing, service],
      );
      yield* database.query(
        `insert into subject_closure (namespace, ancestor_id, descendant_id, depth, via, revision)
         values ('user:pr2-u1', $1, $2, 1, 'split', 2)`,
        [service, exports],
      );
      yield* database.query("select knowledge_rebuild_matches()");
      yield* database.query(`delete from "user" where id = 'pr2-u1'`);
      expect(
        yield* database.query(
          `select
             (select count(*)::int from subjects where owner_id = 'pr2-u1') as subjects,
             (select count(*)::int from subject_labels where namespace = 'user:pr2-u1') as labels,
             (select count(*)::int from subject_canonical where namespace = 'user:pr2-u1') as canonical,
             (select count(*)::int from subject_closure where namespace = 'user:pr2-u1') as closure,
             (select count(*)::int from subject_matches where subject_id = any($1::bigint[])) as matches,
             (select count(*)::int from decisions where namespace = 'user:pr2-u1') as decisions`,
          [[billing, service, exports]],
        ),
      ).toEqual([{ subjects: 0, labels: 0, canonical: 0, closure: 0, matches: 0, decisions: 0 }]);

      yield* database.query(`insert into decisions (owner_id, revision, kind, payload, actor, reason) values
        ('pr2-u3', 1, 'rename', '{"_tag":"Rename","label":"Acme payroll exporter (internal)"}', 'u3', 'clearer name')`);
      yield* database.query(
        "insert into subjects (id, owner_id, label, origin_revision) values ($1, 'pr2-u3', 'Acme payroll exporter (internal)', 1)",
        [payroll],
      );
      const named = `select count(*)::int as rows from decisions where payload ->> 'label' like 'Acme payroll%'`;
      expect(yield* database.query(`${named} and namespace = 'public'`)).toEqual([{ rows: 0 }]);
      yield* database.query(`delete from "user" where id = 'pr2-u3'`);
      expect(yield* database.query(named)).toEqual([{ rows: 0 }]);

      const publicOne = yield* createSubject("public subject");
      const repo = yield* seedRepo({ id: 74_001 });
      yield* database.query("insert into subjects (id, owner_id, label) values ($1, 'pr2-u4', 'private subject')", [
        privateOne,
      ]);
      const code = (text: string, values: ReadonlyArray<unknown> = []) =>
        database.query(text, values).pipe(
          Effect.as("accepted"),
          Effect.catchDefect((defect) => Effect.succeed((defect as { readonly code?: string }).code ?? "no code")),
        );
      expect(
        yield* code(`insert into decisions (owner_id, revision, kind, payload, actor, reason)
          values ('pr2-u4', 1, 'publish', '{"_tag":"Publish"}', 'u4', 'x')`),
      ).toBe("23514");
      expect(yield* code("update subjects set repo_id = $2 where id = $1", [privateOne, repo])).toBe("23514");
      const head = yield* (yield* Db.Db).knowledge.revision;
      expect(
        yield* code(
          "insert into subject_canonical (namespace, origin_id, canonical_id, revision) values ('public', $1, $2, $3)",
          [publicOne, privateOne, head],
        ),
      ).toBe("23503");
      expect(
        yield* code(
          `insert into subject_closure (namespace, ancestor_id, descendant_id, depth, via, revision)
           values ('public', $1, $2, 1, 'parent', $3)`,
          [publicOne, privateOne, head],
        ),
      ).toBe("23503");
    }),
  );
};

const cases = (test: { readonly effect: it.Tester<Services> }) => {
  orderCases(test);
  listingCases(test);
  deletionCases(test);
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 60_000, testTimeout: 60_000 })(
  "PGlite knowledge probes",
  cases,
);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 60_000, testTimeout: 60_000 })(
  "node-postgres knowledge probes",
  cases,
);
