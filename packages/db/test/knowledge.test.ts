import { expect } from "bun:test";
import type { RepoId } from "@stargrep/github/schemas";
import { type Atom, type FacetRef, formatAtom } from "@stargrep/knowledge/atom";
import { decodeFacets } from "@stargrep/knowledge/claims";
import type { SubjectId } from "@stargrep/knowledge/ids";
import { closed, type Dim, roleIds, roles } from "@stargrep/knowledge/registry";
import { renderRegistrySql } from "@stargrep/knowledge/registry-sql";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Db from "../src/db.ts";
import { atomColumns } from "../src/schema.ts";
import * as TestDatabase from "./database.ts";
import { model } from "./fixtures.ts";
import {
  about,
  answer,
  atom,
  batchId,
  claim,
  createSubject,
  decide,
  facetsOf,
  hash,
  key,
  membersMatching,
  newSubjectId,
  nextRevision,
  projectAtoms,
  receiptId,
  seedRepo,
} from "./knowledge-fixtures.ts";

type Services = Db.Db | Db.Transactions | TestDatabase.TestDatabase;

// What the database says to a statement: "accepted", or the SQLSTATE it refused it with.
const refused = Effect.fn("refused")(function* (text: string, values: ReadonlyArray<unknown> = []) {
  const database = yield* TestDatabase.TestDatabase;
  return yield* database.query(text, values).pipe(
    Effect.as("accepted"),
    Effect.catchDefect((defect) => Effect.succeed((defect as { readonly code?: string }).code ?? "no code")),
  );
});

const checkViolation = "23514";

const closedColumnNames = Object.values(atomColumns).flatMap((columns) =>
  Object.entries(columns).flatMap(([dim, column]) => (dim === "subject" ? [] : [column])),
);

// RepoKnowledge.forget: the tombstone, cleared closed arrays, and no facets row, in one statement.
const forget = `
  with gone as (
    update repos set gone_at = now(), ${closedColumnNames.map((column) => `${column} = '{}'`).join(", ")}
    where id = $1 returning id
  )
  delete from repo_facets where repo_id in (select id from gone)`;

const firstText = { summary: "First answer", keywords: ["first"] };
const firstAnswer = { ...firstText, claims: [claim("about", "first")] };
const secondAnswer = { summary: "Second answer", keywords: ["second"], claims: [claim("about", "second")] };

// The answer a repo shows next to the answer its receipt holds, which must be the same.
const shownAnswer = Effect.fn("shownAnswer")(function* (id: number) {
  const database = yield* TestDatabase.TestDatabase;
  const [row] = yield* database.query(
    `select r.summary, r.keywords, json_build_object('summary', c.summary, 'keywords', c.keywords) as "receiptText",
       r.summary_input_hash as "summaryInputHash", r.receipt_id as "receiptId", r.summary_recipe as "summaryRecipe",
       r.enrich_retry_at as "retryAt", f.stale, (select count(*)::int from receipts where repo_id = r.id) as receipts
     from repos r join receipts c on c.id = r.receipt_id join repo_facets f on f.repo_id = r.id where r.id = $1`,
    [id],
  );
  return row;
});

const cases = (test: { readonly effect: it.Tester<Services> }) => {
  test.effect("the database holds the registry's enums and functions exactly as registry.sql generates them", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const rendered = renderRegistrySql();
      const enums = Object.fromEntries(
        [...rendered.matchAll(/create type (knowledge_\w+) as enum \(([^)]*)\);/g)].map(([, name, body]) => [
          name,
          [...(body ?? "").matchAll(/'([^']*)'/g)].map((match) => match[1]),
        ]),
      );
      const functions = Object.fromEntries(
        [...rendered.matchAll(/create function (knowledge_\w+)\([^)]*\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/g)].map(
          ([, name, body]) => [name, body],
        ),
      );
      expect(Object.keys(enums)).toHaveLength(5);
      expect(Object.keys(functions)).toHaveLength(5);
      const storedEnums = yield* database.query(
        `select t.typname as name, array_agg(e.enumlabel::text order by e.enumsortorder) as labels
         from pg_type t join pg_enum e on e.enumtypid = t.oid where t.typname like 'knowledge\\_%' group by t.typname`,
      );
      expect(
        Object.fromEntries(
          storedEnums.map((row) => [(row as { name: string }).name, (row as { labels: unknown }).labels]),
        ),
      ).toEqual(enums);
      const storedFunctions = yield* database.query(
        "select proname as name, prosrc as body from pg_proc where proname = any($1::text[])",
        [Object.keys(functions)],
      );
      expect(
        Object.fromEntries(
          storedFunctions.map((row) => [(row as { name: string }).name, (row as { body: string }).body]),
        ),
      ).toEqual(functions);
    }),
  );

  test.effect("every role keeps one typed array per dimension it accepts, closed ones on repos", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const expected = roleIds.flatMap((role) =>
        roles[role].accepts.map((dim) => ({
          column: (atomColumns[role] as Partial<Record<Dim, string>>)[dim] ?? `missing ${role} ${dim}`,
          table: dim === "subject" ? "repo_facets" : "repos",
          type: dim === "subject" ? "_int8" : `_knowledge_${dim}`,
        })),
      );
      expect(roleIds.flatMap((role) => Object.keys(atomColumns[role]))).toHaveLength(expected.length);
      const stored = yield* database.query(
        `select column_name as column, table_name as table, udt_name as type from information_schema.columns
         where table_schema = 'public' and column_name = any($1::text[]) and table_name in ('repos', 'repo_facets')`,
        [expected.map((entry) => entry.column)],
      );
      expect(stored).toEqual(expect.arrayContaining(expected));
      expect(stored).toHaveLength(expected.length);
    }),
  );

  test.effect("projection stores each role's atoms where the views read them, under the keys the codec writes", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const target = yield* createSubject("round trip subject");
      const values: Readonly<Record<Dim, Atom["value"]>> = {
        kind: { dim: "kind", id: "cli" },
        language: { dim: "language", id: "rust" },
        license: { dim: "license", id: "MIT" },
        platform: { dim: "platform", id: "linux" },
        status: { dim: "status", id: "deprecated" },
        subject: { dim: "subject", id: target },
      };
      const pairs = roleIds.flatMap((role) => roles[role].accepts.map((dim) => ({ role, value: values[dim] })));
      let next = 70_100;
      for (const { role, value } of pairs) {
        const id = yield* seedRepo({ id: next++ });
        expect(yield* projectAtoms(() => [atom(role, value)], [id])).toEqual({ projected: 1, skipped: 0 });
        const held = yield* database.query(
          "select role, dim, value, membership from effective_atoms where repo_id = $1",
          [id],
        );
        const comparison = roles[role].matches === "comparison";
        expect(held).toEqual([{ role, dim: value.dim, value: String(value.id), membership: !comparison }]);
        const keys = yield* database.query("select atom from matching_atoms where repo_id = $1 order by atom", [id]);
        const own = formatAtom({ role, value });
        const bare = formatAtom({ role: "any", value });
        const expected = roles[role].matches === "bare" ? [...new Set([bare, own])].sort() : [own];
        expect(keys.map((row) => (row as { atom: string }).atom)).toEqual(expected);
      }
    }),
  );

  test.effect("a bare subject filter skips built_with, and with: reaches it", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const tauri = yield* createSubject("tauri");
      const builtWith = yield* seedRepo({ id: 70_201 });
      const holder = yield* seedRepo({ id: 70_202 });
      yield* projectAtoms(
        (repo) => [repo.id === builtWith ? atom("built_with", { dim: "subject", id: tauri }) : about(tauri)],
        [builtWith, holder],
      );
      expect(yield* membersMatching(tauri)).toEqual([holder]);
      expect(
        yield* database.query(
          "select repo_id::float8 as id from repo_facets where built_with && knowledge_origins(array[$1]::bigint[], true)",
          [tauri],
        ),
      ).toEqual([{ id: builtWith }]);
      expect(yield* (yield* Db.Db).knowledge.invalidate({ keys: [], subjects: [tauri] })).toBe(2);
    }),
  );

  test.effect("every role's max fits the limits on its columns, so projection never writes a refused row", () =>
    Effect.gen(function* () {
      const subjects: Array<SubjectId> = [];
      for (let n = 0; n < 20; n++) subjects.push(yield* newSubjectId);
      const closedIds: Readonly<Record<Exclude<Dim, "subject">, ReadonlyArray<string>>> = {
        kind: closed.kind.map((value) => value.id),
        language: closed.language.map((value) => value.id),
        license: closed.license.map((value) => value.id),
        platform: closed.platform.map((value) => value.id),
        status: closed.status.map((value) => value.id),
      };
      let next = 73_201;
      for (const role of roleIds) {
        for (const dim of roles[role].accepts) {
          const ids = dim === "subject" ? subjects : closedIds[dim];
          expect([role, dim, ids.length >= roles[role].max]).toEqual([role, dim, true]);
          const atoms = ids.slice(0, roles[role].max).map((id) => atom(role, { dim, id } as FacetRef));
          const repo = yield* seedRepo({ id: next++ });
          expect([role, dim, yield* projectAtoms(() => atoms, [repo])]).toEqual([
            role,
            dim,
            { projected: 1, skipped: 0 },
          ]);
        }
      }
    }),
  );

  test.effect("projection leaves the repos row unwritten when no closed atom changed", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const tui = yield* createSubject("unwritten tui");
      const id = yield* seedRepo({ id: 73_001 });
      const version = Effect.gen(function* () {
        const [row] = yield* database.query(
          "select r.xmin::text as repo, f.xmin::text as facets from repos r join repo_facets f on f.repo_id = r.id where r.id = $1",
          [id],
        );
        return row as { readonly repo: string; readonly facets: string };
      });
      const cli = atom("is", { dim: "kind", id: "cli" });
      yield* projectAtoms(() => [cli, about(tui)], [id]);
      const first = yield* version;
      yield* projectAtoms(() => [cli, about(tui)], [id]);
      const same = yield* version;
      expect(same.repo).toBe(first.repo);
      expect(same.facets).not.toBe(first.facets);
      yield* projectAtoms(() => [cli], [id]);
      expect((yield* version).repo).toBe(first.repo);
      yield* projectAtoms(() => [atom("is", { dim: "kind", id: "library" })], [id]);
      expect((yield* version).repo).not.toBe(first.repo);
      expect(yield* database.query("select kinds::text[] as kinds from repos where id = $1", [id])).toEqual([
        { kinds: ["library"] },
      ]);
    }),
  );

  test.effect("the self rule drops a with: atom whose subject is linked to the repo, as it drops a comparison", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const db = yield* Db.Db;
      const tauri = yield* createSubject("self rule tauri");
      const own = yield* seedRepo({ id: 73_101 });
      const app = yield* seedRepo({ id: 73_102 });
      yield* decide("link", {
        presented: [{ id: tauri, label: "self rule tauri", definition: null, status: "accepted", repoId: own }],
      });
      const held = (value: FacetRef) =>
        [atom("built_with", value), atom("alternative_to", value), atom("about", value)] as const;
      yield* projectAtoms(() => held({ dim: "subject", id: tauri }), [own, app]);
      const rolesOf = (repo: RepoId) =>
        database.query("select role from effective_atoms where repo_id = $1 and dim = 'subject' order by role", [repo]);
      expect(yield* rolesOf(own)).toEqual([{ role: "about" }]);
      expect(yield* rolesOf(app)).toEqual([{ role: "about" }, { role: "alternative_to" }, { role: "built_with" }]);
      const keys = yield* database.query("select atom from matching_atoms where repo_id = $1 order by atom", [own]);
      expect(keys).toEqual([{ atom: `about:subject:${tauri}` }, { atom: `subject:${tauri}` }]);
      yield* db.knowledge.count;
      expect(yield* database.query("select repo_count from subjects where id = $1", [tauri])).toEqual([
        { repo_count: 2 },
      ]);
    }),
  );

  test.effect("refuses writes that break the knowledge invariants", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* createSubject("invariant subject");
      const id = yield* seedRepo({ id: 70_301 });
      yield* db.knowledge.capture([answer(id, receiptId(70_301))]);
      expect(yield* refused("update repos set kinds = '{app,cli,list}' where id = 70301")).toBe(checkViolation);
      expect(yield* refused("update repos set written_in = array[null]::knowledge_language[] where id = 70301")).toBe(
        checkViolation,
      );
      expect(yield* refused("update repos set kinds = '{other}' where id = 70301")).toBe("22P02");
      expect(yield* refused("update repos set input_hash = 'not hex' where id = 70301")).toBe(checkViolation);
      expect(yield* refused("update repo_facets set about = array[null]::bigint[] where repo_id = 70301")).toBe(
        checkViolation,
      );
      expect(yield* refused(`update receipts set summary = 'edited' where id = '${receiptId(70_301)}'`)).toBe(
        checkViolation,
      );
      expect(
        yield* refused(
          `insert into extraction_batches (id, adapter, model, recipe, request_key, request_object, repo_ids,
             input_hashes, state, lease_until)
           values (gen_random_uuid(), 'gateway-batch', 'm', 2, 'k-70301', 'r2/k', '{70301}', array['${hash("a")}'],
             'submitted', now())`,
        ),
      ).toBe(checkViolation);
      expect(yield* refused("insert into subjects (label) values ('no origin')")).toBe(checkViolation);
      expect(yield* refused("update subjects set owner_id = 'someone' where namespace = 'public'")).toBe(
        checkViolation,
      );
      expect(yield* refused("update decisions set reason = 'rewritten'")).toBe(checkViolation);
      expect(yield* refused("delete from decisions")).toBe(checkViolation);
      expect(
        yield* refused(
          `insert into decisions (revision, kind, payload, actor, reason) values (999, 'undo', '{"_tag":"Undo"}', 't', 't')`,
        ),
      ).toBe(checkViolation);
    }),
  );

  test.effect("a receipt keeps its batch, except that the batch expiring clears it", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const id = yield* seedRepo({ id: 70_351 });
      const batch = (n: number) => batchId(`0000000${n}-0000-4000-8000-000000070351`);
      for (const n of [1, 2]) {
        yield* database.query(
          `insert into extraction_batches (id, adapter, model, recipe, request_key, request_object, provider_batch_id,
             repo_ids, input_hashes, state, lease_until)
           values ($1::uuid, 'gateway-batch', 'm', 2, $1::text, 'r2/k', 'b', '{70351}', array['${hash("a")}'], 'captured', now())`,
          [batch(n)],
        );
      }
      yield* db.knowledge.capture([answer(id, receiptId(70_351), { batchId: batch(1) })]);
      expect(yield* refused(`update receipts set batch_id = '${batch(2)}' where repo_id = 70351`)).toBe(checkViolation);
      yield* database.query("delete from extraction_batches where id = $1", [batch(1)]);
      expect(yield* database.query("select batch_id from receipts where repo_id = 70351")).toEqual([
        { batch_id: null },
      ]);
    }),
  );

  test.effect("reserves every closed spelling as a label key and frees the names revision 2's audit freed", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const owner = yield* createSubject("label owner");
      const owned = yield* db.knowledge.revision;
      const insert = (term: string) =>
        `insert into subject_labels (namespace, key, subject_id, is_default, source, revision)
         values ('public', '${term}', ${owner}, false, 'decision', ${owned})`;
      for (const term of ["shell", "node", "library", "macos", "c++", ".net"]) {
        expect(yield* refused(insert(term))).toBe(checkViolation);
      }
      for (const term of ["tui", "postgresql", "workers", "chrome", "ubuntu", "zlib"]) {
        expect(yield* refused(insert(term))).toBe("accepted");
      }
    }),
  );

  test.effect("keeps one default per key and writer, and resolution reads a decision default over a minted one", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = yield* seedRepo({ id: 70_401 });
      const receipt = receiptId(70_401);
      yield* db.knowledge.capture([answer(id, receipt)]);
      const { minted } = yield* db.knowledge.mint([{ key: key("ratatui"), label: "Ratatui", receiptId: receipt }]);
      const curated = yield* createSubject("ratatui (curated)");
      const aliased = yield* nextRevision;
      yield* decide("alias", {
        labelsAdded: [{ key: key("ratatui"), subjectId: curated, isDefault: true, revision: aliased }],
      });
      expect(yield* db.knowledge.labels([key("ratatui")])).toEqual([
        { key: key("ratatui"), subjectId: curated, isDefault: true, source: "decision" },
      ]);
      expect(minted).toHaveLength(1);
      expect(
        yield* refused(
          `insert into subject_labels (namespace, key, subject_id, is_default, source, revision)
           values ('public', 'ratatui', ${minted[0]?.subjectId}, true, 'decision', ${aliased})`,
        ),
      ).toBe("23505");
    }),
  );

  test.effect("a decoded answer with U+0000 and a lone surrogate in its facts is stored and projected", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const id = yield* seedRepo({ id: 73_301 });
      const decoded = decodeFacets(
        [
          { role: "about", term: "dash\u0000boards", quote: "widget\u0000" },
          { role: "trait", term: "off\uD800line" },
        ],
        { fullName: "probe/repo-73301", description: "", topics: [], readme: "" },
      );
      const [captured] = yield* db.knowledge.capture([
        answer(id, receiptId(73_301), { claims: decoded.claims, lanes: decoded.lanes, dropped: decoded.dropped }),
      ]);
      expect(captured?.saved).toBe(true);
      yield* projectAtoms(
        () => [],
        [id],
        (repo) => repo.claims.map((stored) => stored.key),
      );
      expect(
        yield* database.query(
          `select c.claims -> 0 ->> 'term' as term, c.claims -> 1 ->> 'term' as trait, f.unresolved_keys as unresolved
           from receipts c join repo_facets f on f.repo_id = c.repo_id where c.repo_id = $1`,
          [id],
        ),
      ).toEqual([{ term: "dashboards", trait: "off\uFFFDline", unresolved: ["dashboards", "off\uFFFDline"] }]);
    }),
  );

  test.effect("capture saves the summary and points the repo at the receipt, and a retry keeps the first answer", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const id = yield* seedRepo({ id: 70_501 });
      yield* database.query("update repos set enrich_retry_at = now() + interval '1 day' where id = $1", [id]);
      const first = yield* db.knowledge.capture([answer(id, receiptId(70_501), firstAnswer)]);
      expect(first).toEqual([{ repoId: id, receiptId: receiptId(70_501), saved: true }]);
      const retry = yield* db.knowledge.capture([answer(id, receiptId(70_502), secondAnswer)]);
      expect(retry).toEqual([{ repoId: id, receiptId: receiptId(70_501), saved: true }]);
      expect(yield* shownAnswer(id)).toEqual({
        ...firstText,
        receiptText: firstText,
        summaryInputHash: hash("a"),
        receiptId: receiptId(70_501),
        summaryRecipe: 2,
        retryAt: null,
        stale: true,
        receipts: 1,
      });
    }),
  );

  test.effect("a duplicate answer after projection leaves the projected answer and its atoms in place", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const id = yield* seedRepo({ id: 70_551 });
      yield* db.knowledge.capture([answer(id, receiptId(70_551), firstAnswer)]);
      yield* projectAtoms(() => [atom("is", { dim: "kind", id: "cli" })], [id]);
      const duplicate = yield* db.knowledge.capture([answer(id, receiptId(70_552), secondAnswer)]);
      expect(duplicate).toEqual([{ repoId: id, receiptId: receiptId(70_551), saved: true }]);
      expect(yield* shownAnswer(id)).toMatchObject({ ...firstText, receiptText: firstText, stale: false, receipts: 1 });
    }),
  );

  test.effect("capture keeps an answer for moved inputs as history, saves nothing, and clears the lease", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const movedReadme = yield* seedRepo({ id: 70_601, readme: "2" });
      const movedInputs = yield* seedRepo({ id: 70_602, input: "b" });
      yield* database.query("update repos set enrich_retry_at = now() + interval '1 day' where id in (70601, 70602)");
      const captured = yield* db.knowledge.capture([
        answer(movedReadme, receiptId(70_601)),
        answer(movedInputs, receiptId(70_602)),
      ]);
      expect(captured.map((row) => row.saved)).toEqual([false, false]);
      expect(
        yield* database.query(
          `select r.summary, r.receipt_id as "receiptId", r.enrich_retry_at as "retryAt",
             (select count(*)::int from receipts where repo_id = r.id) as receipts
           from repos r where r.id in (70601, 70602) order by r.id`,
        ),
      ).toEqual([
        { summary: null, receiptId: null, retryAt: null, receipts: 1 },
        { summary: null, receiptId: null, retryAt: null, receipts: 1 },
      ]);
    }),
  );

  test.effect("a new summary of the same README keeps the embedding, marked stale, as saveSummary does", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const id = yield* seedRepo({ id: 70_701 });
      yield* database.query(
        `update repos set summary = 'old', summary_readme_oid = readme_oid, embedding_model = $2,
           embedding = array_fill(0.5, array[1024])::halfvec where id = $1`,
        [id, model],
      );
      yield* db.knowledge.capture([answer(id, receiptId(70_701))]);
      expect(
        yield* database.query(
          "select embedding_model as model, embedding_stale as stale, embedding is not null as kept from repos where id = $1",
          [id],
        ),
      ).toEqual([{ model, stale: true, kept: true }]);
    }),
  );

  test.effect("mint creates a subject once per key and marks the repos that missed the key", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const early = yield* seedRepo({ id: 70_801, topics: ["acme widget"] });
      const minter = yield* seedRepo({ id: 70_802 });
      yield* projectAtoms(
        () => [],
        [early],
        () => [key("acme widget")],
      );
      expect((yield* facetsOf(early))?.stale).toBe(false);
      yield* db.knowledge.capture([answer(minter, receiptId(70_802))]);
      const claim = { key: key("acme widget"), label: "Acme Widget", receiptId: receiptId(70_802) };
      const first = yield* db.knowledge.mint([claim, claim]);
      expect(first.minted).toHaveLength(1);
      expect(first.invalidated).toBe(1);
      expect((yield* facetsOf(early))?.stale).toBe(true);
      expect(yield* db.knowledge.mint([claim])).toEqual({ minted: [], invalidated: 0 });
      const [minted] = first.minted;
      if (minted === undefined) return yield* Effect.die(new Error("nothing minted"));
      expect(yield* db.knowledge.labels([key("acme widget")])).toEqual([
        { key: key("acme widget"), subjectId: minted.subjectId, isDefault: true, source: "minted" },
      ]);
      yield* projectAtoms(() => [about(minted.subjectId)], [minter]);
      expect(yield* membersMatching(minted.subjectId)).toEqual([minter]);
    }),
  );

  test.effect(
    "projection writes only where the repo still points at the receipt, and leaves unchanged arrays alone",
    () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const id = yield* seedRepo({ id: 70_901 });
        yield* db.knowledge.capture([answer(id, receiptId(70_901))]);
        const cli = [atom("is", { dim: "kind", id: "cli" })];
        const outdated = yield* db.knowledge.project([id], (locked) =>
          Effect.succeed(
            locked.map((repo) => ({
              repoId: repo.id,
              receiptId: receiptId(70_999),
              atoms: cli,
              unresolvedKeys: [],
              verdicts: [],
            })),
          ),
        );
        expect(outdated).toEqual({ projected: 0, skipped: 1 });
        expect(yield* projectAtoms(() => cli, [id])).toEqual({ projected: 1, skipped: 0 });
        const version = "select xmin::text as version, kinds::text[] as kinds from repos where id = $1";
        const [written] = yield* database.query(version, [id]);
        expect(written).toMatchObject({ kinds: ["cli"] });
        yield* projectAtoms(() => cli, [id]);
        expect(yield* database.query(version, [id])).toEqual([written]);
        expect(
          yield* database.query(
            "select projected_revision is not null as projected, verdicts from receipts where id = $1",
            [receiptId(70_901)],
          ),
        ).toEqual([{ projected: true, verdicts: [] }]);
      }),
  );

  test.effect("a gone repo keeps a late answer as history and gets no facets row until GitHub serves it again", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const database = yield* TestDatabase.TestDatabase;
      const id = yield* seedRepo({ id: 71_001, language: "Rust" });
      yield* db.knowledge.capture([answer(id, receiptId(71_001))]);
      yield* projectAtoms(() => [atom("written_in", { dim: "language", id: "rust" })], [id]);
      yield* database.query(forget, [id]);
      expect(yield* facetsOf(id)).toBeUndefined();
      const late = yield* db.knowledge.capture([answer(id, receiptId(71_002), { recipe: 3 })]);
      expect(late).toEqual([{ repoId: id, receiptId: receiptId(71_002), saved: false }]);
      expect(yield* facetsOf(id)).toBeUndefined();
      expect(yield* db.knowledge.project([id], () => Effect.succeed([]))).toEqual({ projected: 0, skipped: 1 });
      yield* database.query(`update repos set topics = '["late"]' where id = $1`, [id]);
      expect(yield* facetsOf(id)).toBeUndefined();
      expect(
        yield* database.query("select count(*)::int as atoms from effective_atoms where repo_id = $1", [id]),
      ).toEqual([{ atoms: 0 }]);
      yield* database.query("update repos set gone_at = null where id = $1", [id]);
      expect((yield* facetsOf(id))?.stale).toBe(true);
      expect(yield* db.knowledge.stale(100_000)).toContain(id);
    }),
  );

  test.effect("undoing an alias removal puts the curated label back over the subject a mint made meanwhile", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const fluxcap = key("fluxcap");
      const canonical = yield* createSubject("canonical topic");
      const aliased = yield* decide("alias", {
        labelsAdded: [{ key: fluxcap, subjectId: canonical, isDefault: true, revision: yield* nextRevision }],
      });
      const id = yield* seedRepo({ id: 71_101 });
      const receipt = receiptId(71_101);
      yield* db.knowledge.capture([answer(id, receipt)]);
      // A stand-in for projection: the repo's one about claim, minted first when no label has its key.
      const sweep = Effect.gen(function* () {
        yield* db.knowledge.mint([{ key: fluxcap, label: "fluxcap", receiptId: receipt }]);
        yield* db.knowledge.project([id], () =>
          Effect.map(db.knowledge.labels([fluxcap]), (labels) => [
            {
              repoId: id,
              receiptId: receipt,
              atoms: labels.filter((label) => label.isDefault).map((label) => about(label.subjectId)),
              unresolvedKeys: [],
              verdicts: [],
            },
          ]),
        );
      });
      yield* sweep;
      expect((yield* facetsOf(id))?.about).toEqual([canonical]);

      const removal = yield* decide("alias", {
        labelsRemoved: [{ key: fluxcap, subjectId: canonical }],
        invalidate: { keys: [], subjects: [canonical] },
      });
      expect(removal.invalidated).toBe(1);
      yield* sweep;
      const minted = (yield* facetsOf(id))?.about[0] as SubjectId;
      expect(minted).not.toBe(canonical);

      const undo = yield* decide(
        "undo",
        {
          labelsAdded: [{ key: fluxcap, subjectId: canonical, isDefault: true, revision: aliased.revision }],
          invalidate: { keys: [fluxcap], subjects: [minted] },
        },
        removal.revision,
      );
      expect(undo.invalidated).toBe(1);
      expect(yield* db.knowledge.labels([fluxcap])).toEqual([
        { key: fluxcap, subjectId: canonical, isDefault: true, source: "decision" },
      ]);
      yield* sweep;
      expect(yield* membersMatching(canonical)).toEqual([id]);
      expect(yield* membersMatching(minted)).toEqual([]);
    }),
  );

  test.effect("a merge under a split rule, and its undo, re-project the holders of both classes", () =>
    Effect.gen(function* () {
      const alias = yield* createSubject("alias agent");
      const broad = yield* createSubject("agent broad");
      const child = yield* newSubjectId;
      yield* decide("split", {
        created: [{ id: child, label: "browser agent", definition: "narrow", status: "accepted" }],
        edgesAdded: [{ ancestorId: broad, descendantId: child, depth: 1, via: "split", revision: yield* nextRevision }],
      });
      const id = yield* seedRepo({ id: 71_201 });
      // The survivor's split rule pins this repo to the child once the merge makes the survivor its subject.
      let stored = alias;
      const sweep = projectAtoms(() => [about(stored)], [id]);
      yield* sweep;

      const classes = { keys: [], subjects: [alias, broad, child] };
      const merge = yield* decide("merge", {
        merged: [{ originId: alias, canonicalId: broad, revision: yield* nextRevision }],
        invalidate: classes,
      });
      expect(merge.invalidated).toBe(1);
      expect((yield* facetsOf(id))?.stale).toBe(true);
      stored = child;
      yield* sweep;
      expect(yield* membersMatching(child)).toEqual([id]);

      const undo = yield* decide("undo", { unmerged: [alias], invalidate: classes }, merge.revision);
      expect(undo.invalidated).toBe(1);
      expect((yield* facetsOf(id))?.stale).toBe(true);
      stored = alias;
      yield* sweep;
      expect(yield* membersMatching(alias)).toEqual([id]);
    }),
  );

  test.effect("a decision computed against an older revision is refused", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      yield* createSubject("revision guard");
      const head = yield* db.knowledge.revision;
      const stale = yield* db.knowledge
        .decide({
          expected: (head - 1) as typeof head,
          kind: "status",
          payload: { _tag: "Status" },
          undoes: null,
          actor: "test",
          reason: "test",
          change: Db.noChange,
        })
        .pipe(Effect.flip);
      expect(stale).toMatchObject({ _tag: "StaleRevision", expected: head - 1, head });
      expect(yield* db.knowledge.revision).toBe(head);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 30_000, testTimeout: 30_000 })(
  "PGlite knowledge",
  cases,
);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 30_000, testTimeout: 30_000 })(
  "node-postgres knowledge",
  cases,
);
