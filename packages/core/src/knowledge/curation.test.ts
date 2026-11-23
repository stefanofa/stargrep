import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import * as TestDatabase from "@stargrep/db/test-database";
import type { RepoId } from "@stargrep/github/schemas";
import { derive } from "@stargrep/knowledge/curation";
import { type Decision, fold, type KnowledgeState, rules } from "@stargrep/knowledge/decisions";
import { generate, random } from "@stargrep/knowledge/decisions.fixture";
import { Revision, SubjectId } from "@stargrep/knowledge/ids";
import { noise, type SeedEntry } from "@stargrep/knowledge/seeds";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Curation from "./curation.ts";
import { exploreEntries } from "./explore.ts";
import { answer, create, createdBy, embeddingModel, key, record, seed, split, sweepAll } from "./knowledge.fixture.ts";
import * as RepoKnowledge from "./repo-knowledge.ts";

type Services = Db.Db | Db.Transactions | TestDatabase.TestDatabase;

const head = Effect.flatMap(Db.Db, (db) => db.knowledge.revision);

const membersMatching = Effect.fn("membersMatching")(function* (id: SubjectId) {
  const database = yield* TestDatabase.TestDatabase;
  const rows = yield* database.query(
    `select repo_id::float8 as id from repo_facets where members && knowledge_origins(array[$1]::bigint[], true)
     order by repo_id`,
    [id],
  );
  return rows.map((row) => (row as { readonly id: number }).id);
});

const aboutOf = Effect.fn("aboutOf")(function* (id: number) {
  const database = yield* TestDatabase.TestDatabase;
  const [row] = yield* database.query("select about::float8[] as about from repo_facets where repo_id = $1", [id]);
  return (row as { readonly about: ReadonlyArray<number> } | undefined)?.about ?? [];
});

const rows = Effect.fn("rows")(function* (text: string) {
  const database = yield* TestDatabase.TestDatabase;
  return (yield* database.query(text)).map((row) => JSON.stringify(row));
});

// subject_matches as decisions left it, then as the full rebuild writes it.
const matchesAgree = Effect.gen(function* () {
  const database = yield* TestDatabase.TestDatabase;
  const read = rows("select subject_id::float8, comparison, origin_id::float8 from subject_matches order by 1, 2, 3");
  const kept = yield* read;
  yield* database.query("select knowledge_rebuild_matches()");
  return { kept, rebuilt: yield* read };
});

// repo_matching_keys once the sweep fills the rows decisions cleared, then as its rule gives it for every repo. Filling
// writes only cleared rows, so a row a trigger left wrong stays wrong.
const keysAgree = Effect.gen(function* () {
  const db = yield* Db.Db;
  while ((yield* db.knowledge.refillKeys(1000)) === 1000);
  return {
    kept: yield* rows("select repo_id::float8 as id, keys from repo_matching_keys order by repo_id"),
    rebuilt: yield* rows(
      "select repo_id::float8 as id, keys from knowledge_matching_keys(array(select id from repos)) order by repo_id",
    ),
  };
});

// The rows decisions own, as the database holds them, against the fold of the database's own log.
const derivedAgree = Effect.gen(function* () {
  const db = yield* Db.Db;
  const derived = derive(fold(yield* db.knowledge.decisions).state);
  const sorted = (values: ReadonlyArray<unknown>) => values.map((value) => JSON.stringify(value)).sort();
  const stored = {
    labels: yield* rows(
      `select key, subject_id::float8 as "subjectId", revision::float8 as revision from subject_labels
       where source = 'decision' order by key`,
    ),
    canonical: yield* rows(
      `select origin_id::float8 as "originId", canonical_id::float8 as "canonicalId", revision::float8 as revision
       from subject_canonical order by origin_id`,
    ),
    closure: yield* rows(
      `select ancestor_id::float8 as "ancestorId", descendant_id::float8 as "descendantId", depth, via,
         revision::float8 as revision
       from subject_closure order by 1, 2`,
    ),
    statuses: yield* rows(
      `select id::float8 as id, status, definition, repo_id::float8 as "repoId" from subjects
       where id = any(array[${[...derived.subjects.keys(), 0].join(",")}]::bigint[]) order by id`,
    ),
  };
  return {
    stored: Object.fromEntries(Object.entries(stored).map(([name, values]) => [name, [...values].sort()])),
    derived: {
      labels: sorted(
        [...derived.labels.values()].map(({ key, subjectId, revision }) => ({ key, subjectId, revision })),
      ),
      canonical: sorted([...derived.canonical.values()]),
      closure: sorted([...derived.closure.values()]),
      statuses: sorted(
        [...derived.subjects.values()].map(({ id, status, definition, repoId }) => ({
          id,
          status,
          definition,
          repoId,
        })),
      ),
    },
  };
});

// Every decision-derived table and every facets row, for subjects that existed before a given ID only, because a
// subject a projection mints between an undo and its redo stays as an empty tombstone.
const snapshot = Effect.fn("snapshot")(function* (below: number) {
  return {
    subjects: yield* rows(
      `select id::float8, label, definition, status, repo_id::float8 from subjects where id < ${below} order by id`,
    ),
    labels: yield* rows(
      `select key, subject_id::float8, source, revision::float8 from subject_labels where subject_id < ${below}
       order by key, subject_id`,
    ),
    canonical: yield* rows(
      "select origin_id::float8, canonical_id::float8, revision::float8 from subject_canonical order by 1",
    ),
    closure: yield* rows(
      "select ancestor_id::float8, descendant_id::float8, depth, via from subject_closure order by 1, 2",
    ),
    matches: yield* rows(
      `select subject_id::float8, comparison, origin_id::float8 from subject_matches where subject_id < ${below}
       order by 1, 2, 3`,
    ),
    facets: yield* rows(
      `select repo_id::float8, stale, members::float8[], built_with::float8[], alternative_to::float8[],
         unresolved_keys from repo_facets order by repo_id`,
    ),
  };
});

const rulesOf = (state: Pick<KnowledgeState, "canonical" | "splits" | "corrections">) => ({
  canonical: [...state.canonical].sort(),
  splits: [...state.splits]
    .map(([broad, entries]) => [broad, entries.map((entry) => [entry.revision, entry.into])])
    .sort(),
  corrections: [...state.corrections].sort(),
});

const maxSubject = Effect.gen(function* () {
  const database = yield* TestDatabase.TestDatabase;
  const [row] = yield* database.query("select coalesce(max(id), 0)::float8 as id from subjects");
  return (row as { readonly id: number }).id;
});

const decideOne = (decision: Decision, operator = true) =>
  Effect.flatMap(head, (expected) =>
    Curation.decide({ decisions: [{ decision, reason: "test" }], expected, actor: "test", operator }),
  );

const undoOne = (revision: Revision, cascade = false) =>
  Effect.flatMap(head, (expected) =>
    Curation.undo({ revision, cascade, expected, actor: "test", reason: "test", operator: true }),
  );

const refusal = <A, R>(
  effect: Effect.Effect<A, Curation.CurationError | DbQueryFailed | DbRowInvalid, R>,
): Effect.Effect<string, DbQueryFailed | DbRowInvalid, R> =>
  effect.pipe(
    Effect.map((): string => "applied"),
    Effect.catchTags({
      CurationRefused: (error) => Effect.succeed(error.reason),
      CurationConflict: () => Effect.succeed("conflict"),
      OperatorRequired: () => Effect.succeed("operator"),
      StaleRevision: () => Effect.succeed("stale"),
    }),
  );

// Six minted subjects on eight repos, ids 1 to 6 in a fresh database, with quotes a "browser" split rule matches.
const mintedFixture = Effect.gen(function* () {
  const terms = ["mint one", "mint two", "mint three", "mint four", "mint five", "mint six"];
  yield* seed(
    Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      owner: index % 2 === 0 ? "even" : "odd",
      facets: [
        { role: "about", term: terms[index % 6] ?? "", quote: index % 3 === 0 ? "a browser tool" : "a library" },
        { role: "about", term: terms[(index + 2) % 6] ?? "", quote: "a service" },
        { role: "alternative_to", term: terms[(index + 4) % 6] ?? "", quote: "like the other one" },
      ],
    })),
  );
  yield* sweepAll;
  return terms.map((_, index) => SubjectId.make(index + 1));
});

const propertyCases = (test: { readonly effect: it.Tester<Services> }) => {
  test.effect(
    "after every decision and undo, subject_matches equals the full rebuild and the tables equal the fold",
    () =>
      Effect.gen(function* () {
        const minted = yield* mintedFixture;
        const db = yield* Db.Db;
        const created: Array<SubjectId> = [];
        let applied = 0;
        let cascaded = 0;
        for (const seedValue of [3, 7, 11, 19, 29]) {
          const next = random(seedValue);
          for (let step = 0; step < 40; step++) {
            const state = fold(yield* db.knowledge.decisions).state;
            const decision = generate(next, state, created, minted, [1, 2, 3]);
            const cascade = decision._tag === "Undo" && next() < 0.5;
            const outcome = yield* refusal(
              decision._tag === "Undo" ? undoOne(decision.revision, cascade) : decideOne(decision),
            );
            if (outcome !== "applied") continue;
            applied++;
            if (cascade) cascaded++;
            const made = (yield* db.knowledge.decisions).at(-1)?.created;
            if (made !== null && made !== undefined) created.push(made);
            const matches = yield* matchesAgree;
            expect(matches.kept).toEqual(matches.rebuilt);
            const tables = yield* derivedAgree;
            expect(tables.stored).toEqual(tables.derived);
            const folded = fold(yield* db.knowledge.decisions);
            expect(folded.invalid).toEqual([]);
            const replayed = rules(yield* db.knowledge.rules);
            expect(rulesOf(replayed)).toEqual(rulesOf(folded.state));
            expect(
              yield* rows(
                `select a.origin_id from subject_canonical a join subject_canonical b on b.origin_id = a.canonical_id`,
              ),
            ).toEqual([]);
            const keys = yield* keysAgree;
            expect(keys.kept).toEqual(keys.rebuilt);
            if (step % 6 === 5) {
              yield* sweepAll;
              const swept = yield* keysAgree;
              expect(swept.kept).toEqual(swept.rebuilt);
            }
          }
        }
        expect(applied).toBeGreaterThan(70);
        expect(cascaded).toBeGreaterThan(2);

        // Projection converges to one answer whatever order the repos go in.
        yield* sweepAll;
        const settled = yield* snapshot(Number.MAX_SAFE_INTEGER);
        const database = yield* TestDatabase.TestDatabase;
        yield* database.query("update repo_facets set stale = true");
        const order = [8, 3, 6, 1, 7, 2, 5, 4];
        for (const id of order) yield* RepoKnowledge.projectRepos([id as RepoId]);
        yield* sweepAll;
        expect((yield* snapshot(Number.MAX_SAFE_INTEGER)).facets).toEqual(settled.facets);
        const keys = yield* keysAgree;
        expect(keys.kept).toEqual(keys.rebuilt);
      }),
  );

  test.effect("after every edge added, removed, or undone, subject_matches equals the full rebuild", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const minted = [1, 2, 3, 4, 5, 6].map((id) => SubjectId.make(id));
      let removals = 0;
      for (const seedValue of [5, 13, 31]) {
        const next = random(seedValue);
        const pick = <A>(values: ReadonlyArray<A>): A => values[Math.floor(next() * values.length)] as A;
        for (let step = 0; step < 25; step++) {
          const log = yield* db.knowledge.decisions;
          const state = fold(log).state;
          const edges = log.filter(
            (entry) =>
              !state.undone.has(entry.revision) &&
              (entry.decision._tag === "Parent" || entry.decision._tag === "Expand" || entry.decision._tag === "Split"),
          );
          const choice = next();
          const outcome =
            choice < 0.3
              ? yield* refusal(decideOne({ _tag: "Parent", child: pick(minted), parent: pick(minted) }))
              : choice < 0.45
                ? yield* refusal(decideOne({ _tag: "Parent", child: pick(minted), parent: null }))
                : choice < 0.6
                  ? yield* refusal(
                      decideOne({ _tag: "Expand", from: pick(minted), to: pick(minted), add: next() < 0.6 }),
                    )
                  : edges.length > 0
                    ? yield* refusal(undoOne(pick(edges).revision, next() < 0.5))
                    : "skipped";
          if (outcome !== "applied") continue;
          const after = fold(yield* db.knowledge.decisions).state;
          if (
            after.parents.size + [...after.expands.values()].reduce((n, set) => n + set.size, 0) <
            state.parents.size + [...state.expands.values()].reduce((n, set) => n + set.size, 0)
          )
            removals++;
          const matches = yield* matchesAgree;
          expect(matches.kept).toEqual(matches.rebuilt);
          const keys = yield* keysAgree;
          expect(keys.kept).toEqual(keys.rebuilt);
        }
      }
      expect(removals).toBeGreaterThan(5);
    }),
  );

  test.effect("an undo then its redo restores every derived table and every facets row after the sweep", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* sweepAll;
      const log = yield* db.knowledge.decisions;
      const state = fold(log).state;
      let checked = 0;
      for (const target of [...log].reverse().slice(0, 12)) {
        if (state.undone.has(target.revision) || target.decision._tag === "Publish") continue;
        const below = (yield* maxSubject) + 1;
        const before = yield* snapshot(below);
        const undone = yield* refusal(undoOne(target.revision));
        if (undone !== "applied") continue;
        yield* sweepAll;
        const undoRevision = yield* head;
        expect(yield* refusal(undoOne(undoRevision))).toBe("applied");
        yield* sweepAll;
        expect(yield* snapshot(below)).toEqual(before);
        checked++;
      }
      expect(checked).toBeGreaterThan(3);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel }), { timeout: 120_000, testTimeout: 600_000 })(
  "PGlite curation fold",
  propertyCases,
);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel }), { timeout: 120_000, testTimeout: 600_000 })(
  "node-postgres curation fold",
  propertyCases,
);

const _browserRule = { labels: [], terms: [["browser", "user-agent"] as [string, ...Array<string>]], repos: [] };

const cases = (test: { readonly effect: it.Tester<Services> }) => {
  test.effect("refuses each reason it can reach, with the holder of a minted key", () =>
    Effect.gen(function* () {
      yield* seed([{ id: 30_001, facets: [{ role: "about", term: "refusal mint", quote: "x" }] }]);
      yield* sweepAll;
      const [minted] = (yield* (yield* Db.Db).knowledge.labels([key("refusal mint")])).map((label) => label.subjectId);
      const [a, b, c, d, e] = yield* Effect.forEach(["r a", "r b", "r c", "r d", "r e"], (label) => create(label));
      if (
        a === undefined ||
        b === undefined ||
        c === undefined ||
        d === undefined ||
        e === undefined ||
        minted === undefined
      )
        return yield* Effect.die("fixture");
      yield* decideOne({ _tag: "KeepApart", a, b, add: true });
      expect(yield* refusal(decideOne({ _tag: "Merge", from: a, into: b }))).toBe("keep-apart");
      yield* decideOne({ _tag: "Parent", child: c, parent: d });
      expect(yield* refusal(decideOne({ _tag: "Parent", child: d, parent: c }))).toBe("cycle");
      // A merge across an edge folds the hierarchy into one meaning, so it is refused too.
      expect(yield* refusal(decideOne({ _tag: "Merge", from: c, into: d }))).toBe("cycle");
      yield* decideOne({ _tag: "Parent", child: e, parent: c });
      const [f] = yield* Effect.forEach(["r f"], (label) => create(label));
      if (f === undefined) return yield* Effect.die("fixture");
      yield* decideOne({ _tag: "Parent", child: f, parent: e });
      const [g] = yield* Effect.forEach(["r g"], (label) => create(label));
      if (g === undefined) return yield* Effect.die("fixture");
      expect(yield* refusal(decideOne({ _tag: "Expand", from: f, to: g, add: true }))).toBe("too-deep");
      yield* decideOne({ _tag: "Merge", from: g, into: a });
      expect(yield* refusal(decideOne({ _tag: "Status", subject: g, status: "accepted" }))).toBe("not-live");
      // Selections land with pages, so no Publish names a live one yet.
      expect(yield* refusal(decideOne({ _tag: "Publish", selection: 1 as never, slug: "topics/x", title: "X" }))).toBe(
        "not-live",
      );
      yield* seed([{ id: 30_002 }]);
      yield* decideOne({ _tag: "Link", subject: a, repo: 30_002 });
      expect(yield* refusal(decideOne({ _tag: "Link", subject: b, repo: 30_002 }))).toBe("link-conflict");
      expect(yield* refusal(decideOne({ _tag: "Alias", subject: b, label: "R A", add: true }))).toBe("label-taken");
      const aliasMinted: Decision = { _tag: "Alias", subject: b, label: "refusal mint", add: true };
      const takenOnDecide = yield* decideOne(aliasMinted).pipe(Effect.flip);
      expect(takenOnDecide).toMatchObject({ _tag: "CurationRefused", reason: "label-taken", holder: minted, index: 0 });
      const takenOnPreview = yield* Curation.preview([{ decision: aliasMinted, reason: "test" }]).pipe(Effect.flip);
      expect(takenOnPreview).toMatchObject({ _tag: "CurationRefused", reason: "label-taken", holder: minted });
      expect(
        yield* refusal(decideOne({ _tag: "Create", label: "Rust", definition: "", aliases: [], status: "accepted" })),
      ).toBe("reserved-label");
      expect(
        yield* refusal(
          decideOne({
            _tag: "Correct",
            repo: 30_001,
            atom: { role: "any", value: { dim: "subject", id: a } },
            present: true,
          }),
        ),
      ).toBe("role-mismatch");
      const stale = yield* Curation.decide({
        decisions: [{ decision: { _tag: "Status", subject: b, status: "accepted" }, reason: "test" }],
        expected: Revision.make((yield* head) - 1),
        actor: "test",
        operator: false,
      }).pipe(Effect.flip);
      expect(stale._tag).toBe("StaleRevision");
      const made = yield* record({ _tag: "Create", label: "r h", definition: "", aliases: [], status: "accepted" });
      const h = yield* createdBy(made);
      const leaning = yield* record({ _tag: "Parent", child: h, parent: b });
      expect(yield* refusal(undoOne(made))).toBe("conflict");
      const cascaded = yield* undoOne(made, true);
      expect(cascaded.undone).toEqual([leaning, made]);
    }),
  );

  test.effect("a decision that moves more than a thousand repos waits for the operator flag", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const big = yield* create("many holders");
      const into = yield* create("merge target");
      yield* seed(Array.from({ length: 1_001 }, (_, index) => ({ id: 40_000 + index })));
      yield* database.query(
        "update repo_facets set about = array[$1]::bigint[], stale = false where repo_id between 40000 and 41000",
        [big],
      );
      const merge: Decision = { _tag: "Merge", from: big, into };
      expect((yield* Curation.preview([{ decision: merge, reason: "test" }])).moved).toEqual([1_001]);
      const waiting = yield* decideOne(merge, false).pipe(Effect.flip);
      expect(waiting).toMatchObject({ _tag: "OperatorRequired", moved: 1_001, index: 0 });
      expect((yield* decideOne(merge, true)).moved).toEqual([1_001]);
    }),
  );

  test.effect(
    "a split moves the claim its rule matches, keeps the ambiguous one, and moves a later receipt it matches",
    () =>
      Effect.gen(function* () {
        const [parser, framework] = yield* seed([
          { id: 50_001, facets: [{ role: "about", term: "agent", quote: "parses the browser user-agent header" }] },
          { id: 50_002, facets: [{ role: "about", term: "agent", quote: "an autonomous coding agent" }] },
        ]);
        yield* sweepAll;
        const [broad] = (yield* (yield* Db.Db).knowledge.labels([key("agent")])).map((label) => label.subjectId);
        if (broad === undefined || parser === undefined || framework === undefined) return yield* Effect.die("fixture");
        const before = yield* membersMatching(broad);
        expect(before).toEqual([parser, framework]);
        const child = yield* split(broad, "User agent parsing", ["browser", "user-agent"]);
        yield* sweepAll;
        expect(yield* aboutOf(parser)).toEqual([child]);
        expect(yield* aboutOf(framework)).toEqual([broad]);
        // The broad selection keeps exactly its old union of repos.
        expect(yield* membersMatching(broad)).toEqual(before);
        expect(yield* membersMatching(child)).toEqual([parser]);

        yield* answer(
          { id: 50_002, facets: [{ role: "about", term: "agent", quote: "reads the browser user-agent" }] },
          50_102,
        );
        yield* sweepAll;
        expect(yield* aboutOf(framework)).toEqual([child]);
        expect(yield* membersMatching(broad)).toEqual(before);
      }),
  );

  test.effect(
    "a merge onto a subject with a split rule moves the holders the rule matches, and its undo moves them back",
    () =>
      Effect.gen(function* () {
        const [onBroad, onAlias] = yield* seed([
          { id: 51_001, facets: [{ role: "about", term: "agents", quote: "an agent runtime" }] },
          { id: 51_002, facets: [{ role: "about", term: "ua lib", quote: "a browser user-agent parser" }] },
        ]);
        yield* sweepAll;
        const db = yield* Db.Db;
        const [broad] = (yield* db.knowledge.labels([key("agents")])).map((label) => label.subjectId);
        const [alias] = (yield* db.knowledge.labels([key("ua lib")])).map((label) => label.subjectId);
        if (broad === undefined || alias === undefined || onAlias === undefined || onBroad === undefined)
          return yield* Effect.die("fixture");
        const child = yield* split(broad, "UA parsing", ["browser", "user-agent"]);
        yield* sweepAll;
        const merged = yield* decideOne({ _tag: "Merge", from: alias, into: broad });
        expect(merged.invalidated).toBe(2);
        yield* sweepAll;
        expect(yield* aboutOf(onAlias)).toEqual([child]);
        expect(yield* membersMatching(child)).toEqual([onAlias]);
        const undone = yield* undoOne(merged.revision);
        expect(undone.invalidated).toBe(2);
        yield* sweepAll;
        expect(yield* aboutOf(onAlias)).toEqual([alias]);
        expect(yield* membersMatching(alias)).toEqual([onAlias]);
        expect(yield* membersMatching(child)).toEqual([]);
      }),
  );

  test.effect("an alias removal lets the key mint its own subject, and its undo resolves the key back", () =>
    Effect.gen(function* () {
      const created = yield* record({
        _tag: "Create",
        label: "Flux capacitor",
        definition: "",
        aliases: ["fluxcap"],
        status: "accepted",
      });
      const subject = yield* createdBy(created);
      const [holder] = yield* seed([{ id: 52_001, facets: [{ role: "about", term: "fluxcap", quote: "x" }] }]);
      yield* sweepAll;
      expect(yield* aboutOf(52_001)).toEqual([subject]);
      const removal = yield* decideOne({ _tag: "Alias", subject, label: "fluxcap", add: false });
      expect(removal.invalidated).toBe(1);
      yield* sweepAll;
      const [mintedId] = yield* aboutOf(52_001);
      expect(mintedId).not.toBe(subject);
      const undone = yield* undoOne(removal.revision);
      expect(undone.invalidated).toBe(1);
      yield* sweepAll;
      expect(yield* aboutOf(52_001)).toEqual([subject]);
      expect(yield* membersMatching(subject)).toEqual([holder as number]);
      expect(yield* membersMatching(mintedId as SubjectId)).toEqual([]);
    }),
  );

  test.effect("a rename of a minted subject is undone back to its first label", () =>
    Effect.gen(function* () {
      yield* seed([{ id: 53_001, facets: [{ role: "about", term: "fooBar", quote: "x" }] }]);
      yield* sweepAll;
      const db = yield* Db.Db;
      const [subject] = (yield* db.knowledge.labels([key("fooBar")])).map((label) => label.subjectId);
      if (subject === undefined) return yield* Effect.die("fixture");
      const renamed = yield* decideOne({ _tag: "Rename", subject, label: "Foo Bar", definition: "A foo for bars." });
      expect((yield* db.knowledge.subjects([subject]))[0]).toMatchObject({
        label: "Foo Bar",
        definition: "A foo for bars.",
      });
      yield* undoOne(renamed.revision);
      expect((yield* db.knowledge.subjects([subject]))[0]).toMatchObject({ label: "fooBar", definition: null });
    }),
  );

  test.effect(
    "seeds adopt the subject holding a topic's own key, leave other holders to the queue, reject noise, and plan nothing twice",
    () =>
      Effect.gen(function* () {
        yield* seed([
          {
            id: 54_001,
            facets: [
              { role: "about", term: "open-source", quote: "x" },
              { role: "about", term: "reactjs", quote: "x" },
            ],
          },
          {
            id: 54_002,
            facets: [
              { role: "about", term: "Open Source", quote: "x" },
              { role: "about", term: "React", quote: "x" },
            ],
          },
          { id: 54_003, facets: [{ role: "about", term: "react", quote: "x" }], topics: ["hacktoberfest"] },
        ]);
        yield* sweepAll;
        const db = yield* Db.Db;
        const labelled = new Map(
          (yield* db.knowledge.labels([key("open source"), key("react"), key("reactjs")])).map((row) => [
            row.key,
            row.subjectId,
          ]),
        );
        const explore: ReadonlyArray<SeedEntry> = [
          {
            key: "react",
            label: "React",
            definition: "A JavaScript library for building user interfaces.",
            aliases: ["reactjs", "react-js", "jsx"],
            synonyms: [],
            status: "accepted",
            reason: "seed",
          },
          {
            key: "zig-lang",
            label: "Ziggy",
            definition: "d",
            aliases: ["zig-lang"],
            synonyms: [],
            status: "accepted",
            reason: "seed",
          },
          {
            key: "open-source",
            label: "Open Source",
            definition: "d",
            aliases: [],
            synonyms: [],
            status: "accepted",
            reason: "seed",
          },
        ];
        const excluded = new Set(noise.flatMap((entry) => [entry.label, ...entry.synonyms]).map(key));

        const noisePlan = yield* Curation.planSeed(noise, new Set());
        const praise = ["secure", "simple", "fast", "enterprise", "modular", "online"];
        expect(noisePlan.decisions.map(({ decision }) => decision._tag)).toEqual([
          "Create",
          "Alias",
          "Alias",
          "Status",
          "Create",
          ...praise.map(() => "Create" as const),
        ]);
        const noiseDone = yield* Curation.seed({ ...noisePlan, actor: "seed:noise", operator: false });
        expect(noiseDone.moved).toEqual([1, 0, 0, 2, 0, ...praise.map(() => 0)]);

        const react = labelled.get(key("react"));
        const reactjs = labelled.get(key("reactjs"));
        if (react === undefined || reactjs === undefined) return yield* Effect.die("fixture");
        const plan = yield* Curation.planSeed(explore, excluded);
        expect(plan.skipped).toEqual([{ label: "Open Source", reason: "excluded" }]);
        expect(plan.decisions.map(({ decision }) => decision._tag)).toEqual(["Rename", "Alias", "Status", "Create"]);
        expect(plan.proposals.map(({ decision }) => decision)).toEqual([{ _tag: "Merge", from: reactjs, into: react }]);
        yield* Curation.seed({ ...plan, actor: "seed:github-explore", operator: false });
        yield* sweepAll;

        // The seed merges nothing: reactjs keeps its repo until a judge takes the merge from the queue.
        expect(yield* membersMatching(react)).toEqual([54_002, 54_003]);
        expect(yield* membersMatching(reactjs)).toEqual([54_001]);
        expect((yield* db.knowledge.subjects([react]))[0]).toMatchObject({ status: "accepted" });
        const queued = yield* Curation.queue({ limit: 10, seeds: [{ entries: explore, excluded }] });
        expect(
          queued
            .filter((proposal) => proposal.channel === "seed")
            .map((proposal) => [proposal.decision, proposal.moved]),
        ).toEqual([[{ _tag: "Merge", from: reactjs, into: react }, 1]]);
        const openSource = labelled.get(key("open source"));
        if (openSource === undefined) return yield* Effect.die("fixture");
        expect(yield* membersMatching(openSource)).toEqual([]);
        const [hacktoberfest] = (yield* db.knowledge.labels([key("hacktoberfest")])).map((row) => row.subjectId);
        expect(yield* aboutOf(54_003)).toEqual([react]);
        expect(hacktoberfest).toBeDefined();

        expect((yield* Curation.planSeed(noise, new Set())).decisions).toEqual([]);
        expect((yield* Curation.planSeed(explore, excluded)).decisions).toEqual([]);
      }),
  );

  test.effect(
    "a rename cannot take a key minted for a subject the same batch merges, so undoing the merge separates them",
    () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        yield* seed([
          { id: 56_001, facets: [{ role: "about", term: "Tailwind CSS", quote: "x" }] },
          { id: 56_002, facets: [{ role: "about", term: "Tailwind CSS", quote: "x" }] },
          { id: 56_003, facets: [{ role: "about", term: "tailwind", quote: "x" }] },
        ]);
        yield* sweepAll;
        const ids = new Map(
          (yield* db.knowledge.labels([key("tailwind css"), key("tailwind")])).map((row) => [row.key, row.subjectId]),
        );
        const css = ids.get(key("tailwind css"));
        const tailwind = ids.get(key("tailwind"));
        if (css === undefined || tailwind === undefined) return yield* Effect.die("fixture");
        const merge: Decision = { _tag: "Merge", from: css, into: tailwind };
        const both = yield* Curation.decide({
          decisions: [
            { decision: merge, reason: "test" },
            { decision: { _tag: "Rename", subject: tailwind, label: "Tailwind CSS" }, reason: "test" },
          ],
          expected: yield* head,
          actor: "test",
          operator: true,
        }).pipe(Effect.flip);
        expect(both).toMatchObject({ _tag: "CurationRefused", reason: "label-taken", index: 1, holder: css });

        const merged = yield* decideOne(merge);
        yield* sweepAll;
        expect(yield* membersMatching(tailwind)).toEqual([56_001, 56_002, 56_003]);
        yield* undoOne(merged.revision);
        yield* database.query("update repo_facets set stale = true where repo_id between 56001 and 56003");
        yield* sweepAll;
        expect(yield* membersMatching(css)).toEqual([56_001, 56_002]);
        expect(yield* membersMatching(tailwind)).toEqual([56_003]);
      }),
  );

  test.effect("a link to a repo a merged origin holds is refused as link-conflict, before the unique index", () =>
    Effect.gen(function* () {
      const [origin, survivor] = yield* Effect.forEach(["link origin", "link survivor"], (label) => create(label));
      if (origin === undefined || survivor === undefined) return yield* Effect.die("fixture");
      yield* seed([{ id: 57_001 }]);
      yield* decideOne({ _tag: "Link", subject: origin, repo: 57_001 });
      yield* decideOne({ _tag: "Merge", from: origin, into: survivor });
      expect(yield* refusal(decideOne({ _tag: "Link", subject: survivor, repo: 57_001 }))).toBe("link-conflict");
    }),
  );

  test.effect("rejecting a subject moves the holders of its whole merge class", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* seed([
        { id: 58_001, facets: [{ role: "about", term: "class keep", quote: "x" }] },
        { id: 58_002, facets: [{ role: "about", term: "class keep", quote: "x" }] },
        { id: 58_003, facets: [{ role: "about", term: "class merged", quote: "x" }] },
      ]);
      yield* sweepAll;
      const ids = new Map(
        (yield* db.knowledge.labels([key("class keep"), key("class merged")])).map((row) => [row.key, row.subjectId]),
      );
      const kept = ids.get(key("class keep"));
      const merged = ids.get(key("class merged"));
      if (kept === undefined || merged === undefined) return yield* Effect.die("fixture");
      yield* decideOne({ _tag: "Merge", from: merged, into: kept });
      const rejected = yield* Curation.preview([
        { decision: { _tag: "Status", subject: kept, status: "rejected" }, reason: "test" },
      ]);
      expect(rejected.moved).toEqual([3]);
    }),
  );

  test.effect("a split that reuses a label an alias removal freed moves the claim its rule matches", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* seed([
        { id: 59_001, facets: [{ role: "about", term: "agent one", quote: "parses the browser user-agent" }] },
        { id: 59_002, facets: [{ role: "about", term: "agent two", quote: "parses the browser user-agent" }] },
      ]);
      yield* sweepAll;
      const ids = new Map(
        (yield* db.knowledge.labels([key("agent one"), key("agent two")])).map((row) => [row.key, row.subjectId]),
      );
      const one = ids.get(key("agent one"));
      const two = ids.get(key("agent two"));
      if (one === undefined || two === undefined) return yield* Effect.die("fixture");
      const first = yield* split(one, "freed label", ["browser"]);
      yield* sweepAll;
      expect(yield* aboutOf(59_001)).toEqual([first]);
      yield* record({ _tag: "Alias", subject: first, label: "freed label", add: false });
      yield* sweepAll;
      const second = yield* split(two, "freed label", ["browser"]);
      yield* sweepAll;
      expect(yield* aboutOf(59_002)).toEqual([second]);
    }),
  );

  test.effect(
    "the floor leaves alone a candidate a curator decides on, or undoes, after the floor reads its list",
    () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const made = yield* record({
          _tag: "Create",
          label: "race created",
          definition: "",
          aliases: [],
          status: "candidate",
        });
        const created = yield* createdBy(made);
        const terms = ["race rejected", "race merged", "race survivor", "race accepted", "race created"];
        yield* seed(
          [61_001, 61_002, 61_003].map((id, index) => ({
            id,
            owner: index === 0 ? "ann" : "bob",
            facets: terms.map((term) => ({ role: "about", term, quote: "x" })),
          })),
        );
        yield* sweepAll;
        yield* RepoKnowledge.count();
        const ids = new Map((yield* db.knowledge.labels(terms.map(key))).map((row) => [row.key, row.subjectId]));
        const rejected = ids.get(key("race rejected"));
        const merged = ids.get(key("race merged"));
        const survivor = ids.get(key("race survivor"));
        const accepted = ids.get(key("race accepted"));
        if (rejected === undefined || merged === undefined || survivor === undefined || accepted === undefined)
          return yield* Effect.die("fixture");
        expect(ids.get(key("race created"))).toBe(created);
        const curator = Effect.gen(function* () {
          yield* decideOne({ _tag: "Status", subject: rejected, status: "rejected" });
          yield* decideOne({ _tag: "Merge", from: merged, into: survivor });
          yield* decideOne({ _tag: "Status", subject: accepted, status: "accepted" });
          yield* undoOne(made);
        }).pipe(Effect.provideService(Db.Db, db), Effect.orDie);
        const racing = Db.Db.of({
          ...db,
          knowledge: { ...db.knowledge, floor: (page) => Effect.tap(db.knowledge.floor(page), () => curator) },
        });
        const read = (yield* db.knowledge.floor({ after: null, limit: 2_000 })).accepted;
        expect([rejected, merged, survivor, accepted, created].every((id) => read.includes(id))).toBe(true);
        const floored = yield* Curation.floor().pipe(Effect.provideService(Db.Db, racing));
        expect(floored.accepted).toBe(read.length - 4);
        const state = fold(yield* db.knowledge.decisions).state;
        expect([state.subjects.get(rejected)?.status, state.subjects.get(survivor)?.status]).toEqual([
          "rejected",
          "accepted",
        ]);
        expect(state.canonical.get(merged)).toBe(survivor);
        expect(state.retired.has(created)).toBe(true);
        const statusesOf = (subject: SubjectId) =>
          state.log.flatMap((entry) =>
            entry.decision._tag === "Status" && entry.decision.subject === subject ? [entry.decision.status] : [],
          );
        expect([statusesOf(merged), statusesOf(accepted), statusesOf(created)]).toEqual([[], ["accepted"], []]);
      }),
  );

  test.effect("examples reach a comparison only through the subject itself and its splits, never a parent edge", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const parent = yield* create("examples parent");
      const child = yield* create("examples child");
      yield* decideOne({ _tag: "Parent", child, parent });
      const [member, rival] = yield* seed([
        { id: 65_001, facets: [{ role: "about", term: "examples child", quote: "x" }] },
        { id: 65_002, facets: [{ role: "alternative_to", term: "examples child", quote: "x" }] },
      ]);
      if (member === undefined || rival === undefined) return yield* Effect.die("fixture");
      yield* sweepAll;
      const examples = yield* db.knowledge.examples([parent, child], 3);
      expect([examples.get(parent), examples.get(child)]).toEqual([[member], [member, rival]]);
    }),
  );

  test.effect("the queue never proposes a merge the fold refuses, such as a keep-apart pair", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* seed([
        { id: 62_001, facets: [{ role: "about", term: "fold pair", quote: "x" }] },
        { id: 62_002, facets: [{ role: "about", term: "fold pair", quote: "x" }] },
        { id: 62_003, facets: [{ role: "about", term: "fold pairs", quote: "x" }] },
      ]);
      yield* sweepAll;
      const ids = new Map(
        (yield* db.knowledge.labels([key("fold pair"), key("fold pairs")])).map((row) => [row.key, row.subjectId]),
      );
      const one = ids.get(key("fold pair"));
      const more = ids.get(key("fold pairs"));
      if (one === undefined || more === undefined) return yield* Effect.die("fixture");
      const pairs = (proposals: ReadonlyArray<Curation.Proposal>) =>
        proposals.flatMap(({ decision }) =>
          decision._tag === "Merge" && [one, more].includes(decision.from) ? [decision] : [],
        );
      expect(pairs(yield* Curation.queue({ limit: 500 }))).toEqual([{ _tag: "Merge", from: more, into: one }]);
      yield* decideOne({ _tag: "KeepApart", a: one, b: more, add: true });
      expect(pairs(yield* Curation.queue({ limit: 500 }))).toEqual([]);
    }),
  );

  test.effect("the queue reads https as the secure variant of http, not its plural", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* seed([
        { id: 64_001, facets: [{ role: "about", term: "coap", quote: "x" }] },
        { id: 64_002, facets: [{ role: "about", term: "coap", quote: "x" }] },
        { id: 64_003, facets: [{ role: "about", term: "coaps", quote: "x" }] },
      ]);
      yield* sweepAll;
      const ids = new Map(
        (yield* db.knowledge.labels([key("coap"), key("coaps")])).map((row) => [row.key, row.subjectId]),
      );
      const coaps = ids.get(key("coaps"));
      if (coaps === undefined) return yield* Effect.die("fixture");
      const queued = yield* Curation.queue({ limit: 500 });
      expect(queued.filter(({ decision }) => decision._tag === "Merge" && decision.from === coaps)).toEqual([]);
    }),
  );

  test.effect("a reviewed Explore synonym proposes the merge of the subject that holds it", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* seed([
        { id: 63_001, facets: [{ role: "about", term: "PostgreSQL", quote: "x" }] },
        { id: 63_002, facets: [{ role: "about", term: "Postgres", quote: "x" }] },
      ]);
      yield* sweepAll;
      const ids = new Map(
        (yield* db.knowledge.labels([key("postgresql"), key("postgres")])).map((row) => [row.key, row.subjectId]),
      );
      const postgresql = ids.get(key("postgresql"));
      const postgres = ids.get(key("postgres"));
      if (postgresql === undefined || postgres === undefined) return yield* Effect.die("fixture");
      const entries = exploreEntries({
        commit: "0".repeat(40),
        topics: [
          {
            topic: "postgresql",
            label: "PostgreSQL",
            definition: "An object-relational database.",
            aliases: ["postgres", "psql"],
          },
        ],
      });
      const plan = yield* Curation.planSeed(entries, new Set());
      expect(plan.proposals.map(({ decision }) => decision)).toEqual([
        { _tag: "Merge", from: postgres, into: postgresql },
      ]);
    }),
  );

  test.effect("the usage floor accepts candidates on three repos from two owners, each as an undoable decision", () =>
    Effect.gen(function* () {
      yield* seed([
        {
          id: 55_001,
          owner: "ann",
          facets: [
            { role: "about", term: "floor wide", quote: "x" },
            { role: "about", term: "floor narrow", quote: "x" },
          ],
        },
        {
          id: 55_002,
          owner: "ann",
          facets: [
            { role: "about", term: "floor wide", quote: "x" },
            { role: "about", term: "floor narrow", quote: "x" },
          ],
        },
        { id: 55_003, owner: "bob", facets: [{ role: "about", term: "floor wide", quote: "x" }] },
        { id: 55_004, owner: "ann", facets: [{ role: "about", term: "floor narrow", quote: "x" }] },
      ]);
      yield* sweepAll;
      yield* RepoKnowledge.count();
      const db = yield* Db.Db;
      const ids = new Map(
        (yield* db.knowledge.labels([key("floor wide"), key("floor narrow")])).map((row) => [row.key, row.subjectId]),
      );
      const wide = ids.get(key("floor wide"));
      const narrow = ids.get(key("floor narrow"));
      if (wide === undefined || narrow === undefined) return yield* Effect.die("fixture");
      const paged: Array<SubjectId> = [];
      let after: SubjectId | null = null;
      do {
        const page: Db.FloorPage = yield* db.knowledge.floor({ after, limit: 1 });
        paged.push(...page.accepted);
        after = page.last;
      } while (after !== null && after < Math.max(wide, narrow));
      expect(paged.filter((id) => id === wide || id === narrow)).toEqual([wide]);
      const { accepted } = yield* Curation.floor();
      expect(accepted).toBeGreaterThanOrEqual(1);
      const info = new Map((yield* db.knowledge.subjects([wide, narrow])).map((row) => [row.id, row.status]));
      expect([info.get(wide), info.get(narrow)]).toEqual(["accepted", "candidate"]);
      const last = (yield* db.knowledge.decisions).filter((entry) => entry.decision._tag === "Status").at(-1);
      expect(last?.decision).toEqual({ _tag: "Status", subject: wide, status: "accepted" });
      expect((yield* Curation.floor()).accepted).toBe(0);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel }), { timeout: 120_000, testTimeout: 120_000 })(
  "PGlite curation",
  cases,
);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel }), { timeout: 120_000, testTimeout: 120_000 })(
  "node-postgres curation",
  cases,
);

const retryStale = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.retry({ while: (error) => error._tag === "StaleRevision", times: 20 }));

it.layer(TestDatabase.layerNodePostgres({ embeddingModel }), { timeout: 120_000, testTimeout: 120_000 })(
  "node-postgres curation under load",
  (test) => {
    test.effect(
      "a merge and its undo while extraction captures, mints, and projects leave every repo as a fresh projection",
      () =>
        Effect.gen(function* () {
          const database = yield* TestDatabase.TestDatabase;
          const db = yield* Db.Db;
          const ids = Array.from({ length: 24 }, (_, index) => 60_001 + index);
          yield* seed(
            ids.map((id, index) => ({
              id,
              facets: [
                {
                  role: "about",
                  term: index % 2 === 0 ? "load broad" : "load alias",
                  quote: index % 4 < 2 ? "reads the browser user-agent" : "a plain tool",
                },
              ],
            })),
          );
          yield* sweepAll;
          const labelled = new Map(
            (yield* db.knowledge.labels([key("load broad"), key("load alias")])).map((row) => [row.key, row.subjectId]),
          );
          const broad = labelled.get(key("load broad"));
          const alias = labelled.get(key("load alias"));
          if (broad === undefined || alias === undefined) return yield* Effect.die("fixture");
          yield* split(broad, "load parsing", ["browser", "user-agent"]);
          yield* sweepAll;

          const writer = Effect.forEach(
            ids,
            (id, index) =>
              answer(
                {
                  id,
                  facets: [
                    {
                      role: "about",
                      term: index % 3 === 0 ? "load alias" : `load fresh ${index}`,
                      quote: "browser user-agent",
                    },
                    { role: "about", term: "load broad", quote: "a plain tool" },
                  ],
                },
                61_000 + index,
              ).pipe(Effect.andThen(RepoKnowledge.projectSaved([id as RepoId]))),
            { concurrency: 3, discard: true },
          );
          const curator = Effect.gen(function* () {
            for (let round = 0; round < 3; round++) {
              const merged = yield* retryStale(decideOne({ _tag: "Merge", from: alias, into: broad }));
              yield* retryStale(undoOne(merged.revision));
            }
            yield* retryStale(decideOne({ _tag: "Merge", from: alias, into: broad }));
          });
          yield* Effect.all([writer, curator, RepoKnowledge.reproject()], { concurrency: "unbounded", discard: true });
          yield* sweepAll;

          expect(yield* rows("select repo_id from repo_facets where stale")).toEqual([]);
          const matches = yield* matchesAgree;
          expect(matches.kept).toEqual(matches.rebuilt);
          const settled = yield* snapshot(Number.MAX_SAFE_INTEGER);
          yield* database.query("update repo_facets set stale = true");
          yield* sweepAll;
          expect((yield* snapshot(Number.MAX_SAFE_INTEGER)).facets).toEqual(settled.facets);
          expect(yield* membersMatching(broad)).toEqual(ids);
        }),
    );
  },
);
