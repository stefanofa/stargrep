import type { RepoId } from "@stargrep/github/schemas";
import type { FacetRef } from "@stargrep/knowledge/atom";
import type { Claim } from "@stargrep/knowledge/claims";
import { BatchId, InputHash, ReceiptId, Revision, SubjectId } from "@stargrep/knowledge/ids";
import { type LabelKey, labelKey } from "@stargrep/knowledge/label-key";
import type { RoleId } from "@stargrep/knowledge/registry";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Db from "../src/db.ts";
import * as TestDatabase from "./database.ts";
import { readme, repoId } from "./fixtures.ts";

export const subject = Schema.decodeSync(SubjectId);
export const revision = Schema.decodeSync(Revision);
export const batchId = Schema.decodeSync(BatchId);
export const hash = (digit: string) => Schema.decodeSync(InputHash)(digit.repeat(64));
export const receiptId = (n: number) =>
  Schema.decodeSync(ReceiptId)(`00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`);

export const key = (term: string): LabelKey => {
  const result = labelKey(term);
  if (result === null) throw new Error(`no label key for ${term}`);
  return result;
};

export const atom = (role: RoleId, value: FacetRef): Db.StoredAtom => ({ role, value });

// A claim as decodeFacets leaves it on a receipt.
export const claim = (role: RoleId, term: string, overrides: Partial<Claim> = {}): Claim => ({
  ordinal: 0,
  role,
  term,
  key: key(term),
  quote: null,
  found: "term",
  ...overrides,
});
export const about = (id: SubjectId) => atom("about", { dim: "subject", id });

export const allComplete = {
  is: "complete",
  status: "complete",
  written_in: "complete",
  runs_on: "complete",
  for: "complete",
  built_with: "complete",
  about: "complete",
  trait: "complete",
  alternative_to: "complete",
  replaced_by: "complete",
} as const;

export interface SeedRepo {
  readonly id: number;
  readonly description?: string;
  readonly topics?: ReadonlyArray<string>;
  readonly language?: string;
  readonly readme?: string;
  readonly input?: string;
}

const seedRows = (repos: ReadonlyArray<SeedRepo>) =>
  JSON.stringify(
    repos.map((seed) => ({
      id: seed.id,
      owner: "probe",
      name: `repo-${seed.id}`,
      description: seed.description ?? null,
      topics: seed.topics ?? [],
      language: seed.language ?? null,
      readme_oid: readme(seed.readme ?? "1"),
      input_hash: hash(seed.input ?? "a"),
    })),
  );

// Repos with a fixed input hash, written directly so a test can name the hash its answers carry.
export const seedRepos = Effect.fn("seedRepos")(function* (repos: ReadonlyArray<SeedRepo>) {
  const database = yield* TestDatabase.TestDatabase;
  yield* database.query(
    `insert into repos (id, owner, name, description, topics, language, readme_oid, input_hash)
     select * from jsonb_to_recordset($1::jsonb)
       as r (id bigint, owner text, name text, description text, topics jsonb, language text, readme_oid text,
             input_hash text)`,
    [seedRows(repos)],
  );
});

export const seedRepo = Effect.fn("seedRepo")(function* (repo: SeedRepo) {
  yield* seedRepos([repo]);
  return repoId(repo.id);
});

export const answer = (id: RepoId, receipt: ReceiptId, overrides: Partial<Db.Answer> = {}): Db.Answer => ({
  receiptId: receipt,
  repoId: id,
  source: "model",
  inputHash: hash("a"),
  readmeOid: readme("1"),
  recipe: 2,
  model: "recorded-no-model-call",
  batchId: null,
  summary: `summary of ${id}`,
  keywords: [],
  claims: [],
  lanes: allComplete,
  dropped: [],
  rawKey: null,
  lease: null,
  ...overrides,
});

// Projects each repo with the atoms given for it, the way projection will once it decodes receipts.
export const projectAtoms = Effect.fn("projectAtoms")(function* (
  atoms: (repo: Db.LockedRepo) => ReadonlyArray<Db.StoredAtom>,
  ids: ReadonlyArray<RepoId>,
  unresolved: (repo: Db.LockedRepo) => ReadonlyArray<LabelKey> = () => [],
) {
  const db = yield* Db.Db;
  return yield* db.knowledge.project(ids, (locked) =>
    Effect.succeed(
      locked.map((repo) => ({
        repoId: repo.id,
        receiptId: repo.receiptId,
        atoms: atoms(repo),
        unresolvedKeys: unresolved(repo),
        verdicts: [],
      })),
    ),
  );
});

// The revision the next decision takes.
export const nextRevision = Effect.gen(function* () {
  const db = yield* Db.Db;
  return revision((yield* db.knowledge.revision) + 1);
});

// A change written by hand: created rows default to no link and the decision's own revision, and the invalidation to
// no corrected repo.
export interface HandChange extends Partial<Omit<Db.VocabularyChange, "created" | "invalidate">> {
  readonly created?: ReadonlyArray<
    Omit<Db.VocabularyChange["created"][number], "repoId" | "revision"> &
      Partial<Db.VocabularyChange["created"][number]>
  >;
  readonly invalidate?: Omit<Db.VocabularyChange["invalidate"], "repos"> & Partial<Db.VocabularyChange["invalidate"]>;
}

// A decision against the current head. Curation computes the subjects whose matches to rebuild, and here they are every
// subject the change names.
export const decide = Effect.fn("decide")(function* (
  kind: Db.DecisionRow["kind"],
  hand: HandChange,
  undoes: Revision | null = null,
) {
  const db = yield* Db.Db;
  const expected = yield* db.knowledge.revision;
  const own = revision(expected + 1);
  const change: Db.VocabularyChange = {
    ...Db.noChange,
    ...hand,
    created: (hand.created ?? []).map((row) => ({ repoId: null, revision: own, ...row })),
    invalidate: { repos: [], ...(hand.invalidate ?? Db.noChange.invalidate) },
  };
  const refresh = new Set<SubjectId>([
    ...change.created.map((row) => row.id),
    ...change.presented.map((row) => row.id),
    ...change.labelsAdded.map((row) => row.subjectId),
    ...change.labelsRemoved.map((row) => row.subjectId),
    ...change.merged.flatMap((row) => [row.originId, row.canonicalId]),
    ...change.unmerged,
    ...[...change.edgesAdded, ...change.edgesRemoved].flatMap((row) => [row.ancestorId, row.descendantId]),
    ...change.invalidate.subjects,
  ]);
  return yield* db.knowledge.decide({
    expected,
    rows: [{ kind, payload: { _tag: kind }, undoes, actor: "test", reason: "test" }],
    change: { ...change, refresh: hand.refresh ?? [...refresh] },
  });
});

export const newSubjectId = Effect.gen(function* () {
  const db = yield* Db.Db;
  const [id] = yield* db.knowledge.allocate(1);
  return id ?? (yield* Effect.die(new Error("allocate returned no ID")));
});

// An accepted subject, created by its own decision.
export const createSubject = Effect.fn("createSubject")(function* (label: string) {
  const id = yield* newSubjectId;
  yield* decide("create", { created: [{ id, label, definition: null, status: "accepted" }] });
  return id;
});

export interface Facets {
  readonly stale: boolean;
  readonly about: ReadonlyArray<number>;
  readonly tagged: ReadonlyArray<number>;
  readonly for: ReadonlyArray<number>;
  readonly builtWith: ReadonlyArray<number>;
  readonly alternative: ReadonlyArray<number>;
  readonly unresolved: ReadonlyArray<string>;
}

export const facetsOf = Effect.fn("facetsOf")(function* (id: RepoId) {
  const database = yield* TestDatabase.TestDatabase;
  const [row] = yield* database.query(
    `select stale, about::float8[] as about, tagged::float8[] as tagged, for_subjects::float8[] as "for",
       built_with::float8[] as "builtWith", alternative_to::float8[] as alternative, unresolved_keys as unresolved
     from repo_facets where repo_id = $1`,
    [id],
  );
  return row as Facets | undefined;
});

// The repos a bare subject filter returns, through the search predicate on members.
export const membersMatching = Effect.fn("membersMatching")(function* (id: SubjectId) {
  const database = yield* TestDatabase.TestDatabase;
  const rows = yield* database.query(
    `select repo_id::float8 as id from repo_facets where members && knowledge_origins(array[$1]::bigint[], true)
     order by repo_id`,
    [id],
  );
  return rows.map((row) => (row as { readonly id: number }).id);
});
