import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import { ObjectId, RepoId } from "@stargrep/github/schemas";
import { type Claim, decodeFacets } from "@stargrep/knowledge/claims";
import type { Decision } from "@stargrep/knowledge/decisions";
import { InputHash, ReceiptId, type Revision, type SubjectId } from "@stargrep/knowledge/ids";
import { type LabelKey, labelKey } from "@stargrep/knowledge/label-key";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Curation from "./curation.ts";
import * as RepoKnowledge from "./repo-knowledge.ts";

export const embeddingModel = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
export const repoId = Schema.decodeSync(RepoId);
export const readmeOid = Schema.decodeSync(ObjectId)("a".repeat(40));
export const inputHash = Schema.decodeSync(InputHash)("b".repeat(64));
export const receiptId = (n: number) => ReceiptId.make(`00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`);
export const key = (term: string): LabelKey => labelKey(term) ?? (term as LabelKey);

export interface Seed {
  readonly id: number;
  readonly owner?: string;
  readonly language?: string;
  readonly license?: string;
  readonly topics?: ReadonlyArray<string>;
  // Facts as the summary model would write them, decoded against a prompt that quotes each one.
  readonly facets?: ReadonlyArray<{ readonly role: string; readonly term: string; readonly quote?: string }>;
}

const answerOf = (repo: Seed, receipt: ReceiptId, hash: InputHash): Db.Answer => {
  const quotes = (repo.facets ?? []).map((fact) => fact.quote ?? "").join("\n");
  const decoded = decodeFacets(repo.facets, {
    fullName: `probe/repo-${repo.id}`,
    description: "",
    topics: repo.topics ?? [],
    readme: quotes,
  });
  return {
    receiptId: receipt,
    repoId: repoId(repo.id),
    source: "stand-in",
    inputHash: hash,
    readmeOid,
    recipe: 2,
    model: "recorded-no-model-call",
    batchId: null,
    summary: `summary of ${repo.id}`,
    keywords: [],
    claims: decoded.claims as ReadonlyArray<Claim>,
    lanes: decoded.lanes,
    dropped: decoded.dropped,
    rawKey: null,
    lease: null,
  };
};

// A new answer for a repo whose prompt inputs changed, as enrichment saves it: the facts first, then commit A.
const hashOf = (receipt: number) => Schema.decodeSync(InputHash)(receipt.toString(16).padStart(64, "0"));

export const answer = Effect.fn("answer")(function* (repo: Seed, receipt: number) {
  const database = yield* TestDatabase.TestDatabase;
  const db = yield* Db.Db;
  const hash = hashOf(receipt);
  yield* database.query("update repos set input_hash = $2 where id = $1", [repo.id, hash]);
  return yield* db.knowledge.capture([answerOf(repo, receiptId(receipt), hash)]);
});

const seedRows = (repos: ReadonlyArray<Seed>) =>
  JSON.stringify(repos.map((repo) => ({ ...repo, topics: repo.topics ?? [], facets: undefined })));

export const seed = Effect.fn("seed")(function* (repos: ReadonlyArray<Seed>) {
  const database = yield* TestDatabase.TestDatabase;
  const db = yield* Db.Db;
  yield* database.query(
    `insert into repos (id, owner, name, language, license, topics, readme_oid, input_hash)
     select id, coalesce(owner, 'probe'), 'repo-' || id, language, license, topics, $2, $3
     from jsonb_to_recordset($1::jsonb) as r (id bigint, owner text, language text, license text, topics jsonb)`,
    [seedRows(repos), readmeOid, inputHash],
  );
  yield* db.knowledge.capture(
    repos.filter((repo) => repo.facets !== undefined).map((repo) => answerOf(repo, receiptId(repo.id), inputHash)),
  );
  return repos.map((repo) => repoId(repo.id));
});

// One decision through curation, against the current head.
export const record = Effect.fn("record")(function* (decision: Decision) {
  const db = yield* Db.Db;
  const decided = yield* Curation.decide({
    decisions: [{ decision, reason: "test" }],
    expected: yield* db.knowledge.revision,
    actor: "test",
    operator: true,
  });
  return decided.revision;
});

export const createdBy = Effect.fn("createdBy")(function* (revision: Revision) {
  const db = yield* Db.Db;
  const created = (yield* db.knowledge.decisions).find((entry) => entry.revision === revision)?.created;
  return created ?? (yield* Effect.die(new Error(`revision ${revision} created no subject`)));
});

export const create = Effect.fn("create")(function* (label: string) {
  return yield* createdBy(yield* record({ _tag: "Create", label, definition: "", aliases: [], status: "accepted" }));
});

export const split = Effect.fn("split")(function* (subject: SubjectId, label: string, terms: ReadonlyArray<string>) {
  const rule = { labels: [], terms: [terms as [string, ...Array<string>]], repos: [] };
  return yield* createdBy(yield* record({ _tag: "Split", subject, into: { label, definition: "" }, rule }));
});

// Every atom a repo holds, with subjects named by label and the run's tag cut off, so runs compare by meaning.
export const heldBy = Effect.fn("heldBy")(function* (ids: ReadonlyArray<RepoId>, tag: string) {
  const database = yield* TestDatabase.TestDatabase;
  const rows = (yield* database.query(
    `select e.repo_id::float8 as repo, e.role, e.dim, coalesce(s.label, e.value) as value
     from effective_atoms e left join subjects s on e.dim = 'subject' and s.id::text = e.value
     where e.repo_id = any($1::bigint[]) order by e.repo_id, e.role, e.dim, 4`,
    [ids],
  )) as ReadonlyArray<{ repo: number; role: string; dim: string; value: string }>;
  return ids.map((id) =>
    rows
      .filter((row) => row.repo === id)
      .map((row) => `${row.role}:${row.dim}:${tag === "" ? row.value : row.value.replace(` ${tag}`, "")}`),
  );
});

export const staleAmong = Effect.fn("staleAmong")(function* (ids: ReadonlyArray<RepoId>) {
  const database = yield* TestDatabase.TestDatabase;
  const rows = yield* database.query(
    "select count(*)::int as n from repo_facets where stale and repo_id = any($1::bigint[])",
    [ids],
  );
  return (rows[0] as { n: number }).n;
});

export const sweepAll = Effect.gen(function* () {
  for (let pass = 0; pass < 10; pass++) {
    const { projected } = yield* RepoKnowledge.reproject();
    if (projected === 0) return;
  }
});
