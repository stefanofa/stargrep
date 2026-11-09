import * as Db from "@stargrep/db";
import { type DbQueryFailed, type DbRowInvalid, type KeyMinted, StaleRevision } from "@stargrep/db/errors";
import type { RepoId } from "@stargrep/github/schemas";
import { type Change, changeBetween, type Invalidation, impact } from "@stargrep/knowledge/curation";
import {
  Decision,
  extend,
  fold,
  type KnowledgeState,
  type StoredDecision,
  undoing,
} from "@stargrep/knowledge/decisions";
import { Revision, SubjectId } from "@stargrep/knowledge/ids";
import { type LabelKey, labelKey } from "@stargrep/knowledge/label-key";
import { type Holder, type Planned, planSeeds, type SeedEntry } from "@stargrep/knowledge/seeds";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// A decision that moves more repos than this waits for the operator, who passes the operator flag. Smaller ones are a
// judge's call, audited weekly.
export const operatorThreshold = 1_000;

// The usage floor accepts this many candidates in one transaction, so the knowledge lock is never held for long.
const floorBatch = 500;

export const RefusalReason = Schema.Literals([
  "keep-apart",
  "cycle",
  "too-deep",
  "not-live",
  "link-conflict",
  "label-taken",
  "reserved-label",
  "role-mismatch",
]);
export type RefusalReason = typeof RefusalReason.Type;

// The decision at index of a batch is invalid. holder is the subject that already holds the key of a label-taken
// refusal, which the curator merges with instead.
export class CurationRefused extends Schema.TaggedError<CurationRefused, { readonly brand: unique symbol }>()(
  "CurationRefused",
  {
    decision: Schema.String,
    index: Schema.Int,
    reason: RefusalReason,
    holder: Schema.NullOr(SubjectId),
  },
) {
  override get message(): string {
    return `Curation refused the ${this.decision} decision at ${this.index}: ${this.reason}${this.holder === null ? "" : ` (held by subject ${this.holder})`}`;
  }
}

// Undoing revision would make later decisions invalid. Undo those first, newest first, or pass cascade.
export class CurationConflict extends Schema.TaggedError<CurationConflict, { readonly brand: unique symbol }>()(
  "CurationConflict",
  {
    revision: Revision,
    invalidated: Schema.Array(Revision),
  },
) {
  override get message(): string {
    return `Undoing revision ${this.revision} would invalidate ${this.invalidated.length} later decisions: ${this.invalidated.join(", ")}`;
  }
}

export class OperatorRequired extends Schema.TaggedError<OperatorRequired, { readonly brand: unique symbol }>()(
  "OperatorRequired",
  {
    decision: Schema.String,
    index: Schema.Int,
    moved: Schema.Int,
  },
) {
  override get message(): string {
    return `The ${this.decision} decision at ${this.index} moves ${this.moved} repos, over ${operatorThreshold}, and needs the operator flag`;
  }
}

export type CurationError = CurationRefused | CurationConflict | OperatorRequired | StaleRevision;

export interface Proposed {
  readonly decision: Decision;
  readonly reason: string;
}

export interface Decided {
  // The new head.
  readonly revision: Revision;
  // Repos marked stale for the projection sweep.
  readonly invalidated: number;
  // Repos each decision moves, in order.
  readonly moved: ReadonlyArray<number>;
  // The revisions an undo took out, the target last.
  readonly undone: ReadonlyArray<Revision>;
}

// What a run of decisions would do, computed against the head without writing anything.
export interface Preview {
  readonly head: Revision;
  readonly moved: ReadonlyArray<number>;
  readonly operator: boolean;
  // The repos the batch would mark stale, by the invalidation table.
  readonly reproject: number;
  readonly undone: ReadonlyArray<Revision>;
}

interface Plan {
  readonly before: KnowledgeState;
  readonly after: KnowledgeState;
  readonly rows: ReadonlyArray<StoredDecision>;
  readonly reasons: ReadonlyArray<string>;
  readonly impacts: ReadonlyArray<Invalidation>;
}

const kinds: Record<Decision["_tag"], Db.DecisionRow["kind"]> = {
  Create: "create",
  Merge: "merge",
  Split: "split",
  Rename: "rename",
  Alias: "alias",
  Parent: "parent",
  Expand: "expand",
  KeepApart: "keep_apart",
  Status: "status",
  Link: "link",
  Correct: "correct",
  Publish: "publish",
  Retire: "retire",
  Undo: "undo",
};

const encode = Schema.encodeSync(Decision);

const rowOf = (stored: StoredDecision, actor: string, reason: string): Db.DecisionRow => ({
  kind: kinds[stored.decision._tag],
  payload: {
    ...(encode(stored.decision) as { readonly _tag: string; readonly [field: string]: Schema.Json }),
    ...(stored.created === null ? {} : { created: stored.created }),
    ...(stored.base === undefined ? {} : { base: stored.base }),
  },
  undoes: stored.decision._tag === "Undo" ? stored.decision.revision : null,
  actor,
  reason,
});

const refused = (decision: Decision, index: number, reason: RefusalReason, holder: SubjectId | null = null) =>
  new CurationRefused({ decision: decision._tag, index, reason, holder });

const current = Effect.gen(function* () {
  const db = yield* Db.Db;
  return fold(yield* db.knowledge.decisions).state;
});

const checkHead = (state: KnowledgeState, expected: Revision) =>
  state.revision === expected ? Effect.void : Effect.fail(new StaleRevision({ expected, head: state.revision }));

// The log rows for a batch on top of the head, each checked against the fold before it. Selections land with pages,
// so no Publish or Retire names a live one yet, and an Undo goes through undo. A Rename of a minted subject records
// the label it replaces.
const planDecisions = Effect.fn("Curation.planDecisions")(function* (
  state: KnowledgeState,
  batch: ReadonlyArray<Proposed>,
  allocate: (count: number) => Effect.Effect<ReadonlyArray<SubjectId>, DbQueryFailed | DbRowInvalid, Db.Db>,
) {
  const db = yield* Db.Db;
  for (const [index, { decision }] of batch.entries()) {
    if (decision._tag === "Undo" || decision._tag === "Publish" || decision._tag === "Retire") {
      return yield* refused(decision, index, "not-live");
    }
  }
  const makes = batch.filter(({ decision }) => decision._tag === "Create" || decision._tag === "Split").length;
  const ids = makes === 0 ? [] : yield* allocate(makes);
  const renamed = batch.flatMap(({ decision }) =>
    decision._tag === "Rename" && decision.label !== undefined && state.subjects.get(decision.subject)?.label == null
      ? [decision.subject]
      : [],
  );
  const labels = new Map(
    renamed.length === 0 ? [] : (yield* db.knowledge.subjects(renamed)).map((row) => [row.id, row.label] as const),
  );
  let made = 0;
  const rows = batch.map(({ decision }, index): StoredDecision => {
    const created = decision._tag === "Create" || decision._tag === "Split" ? (ids[made++] ?? null) : null;
    const base = decision._tag === "Rename" && decision.label !== undefined ? labels.get(decision.subject) : undefined;
    return {
      revision: Revision.make(state.revision + index + 1),
      decision,
      created,
      ...(base === undefined ? {} : { base }),
    };
  });
  const impacts: Array<Invalidation> = [];
  let after = state;
  for (const [index, row] of rows.entries()) {
    const next = extend(after, [row]);
    if (next._tag === "Invalid") return yield* refused(row.decision, index, next.invalid.reason);
    impacts.push(impact(after, next.state));
    after = next.state;
  }
  return { before: state, after, rows, reasons: batch.map(({ reason }) => reason), impacts } satisfies Plan;
});

const planUndo = Effect.fn("Curation.planUndo")(function* (
  state: KnowledgeState,
  target: Revision,
  cascade: boolean,
  reason: string,
) {
  const undone = undoing(state, target, cascade, Revision.make(state.revision + 1));
  const decision: Decision = { _tag: "Undo", revision: target, cascade };
  if (undone._tag === "Invalid") return yield* refused(decision, 0, undone.invalid.reason);
  if (undone._tag === "Conflict") {
    return yield* new CurationConflict({ revision: target, invalidated: undone.revisions });
  }
  return {
    before: state,
    after: undone.state,
    rows: undone.rows,
    reasons: undone.rows.map(() => reason),
    impacts: [impact(state, undone.state)],
  } satisfies Plan;
});

// A label key a new decision gives a subject, when projection minted it for another subject first. That is a merge,
// so the decision is refused as label-taken, naming the holder.
const mintedConflict = Effect.fn("Curation.mintedConflict")(function* (plan: Plan, change: Change) {
  const db = yield* Db.Db;
  const fresh = change.labelsAdded.filter((row) => row.revision > plan.before.revision);
  if (fresh.length === 0) return;
  const minted = new Map(
    (yield* db.knowledge.minted(fresh.map((row) => row.key))).map((row) => [row.key, row.subjectId]),
  );
  const survivor = (id: SubjectId) => plan.after.canonical.get(id) ?? id;
  for (const row of fresh) {
    const holder = minted.get(row.key);
    if (holder === undefined || survivor(holder) === survivor(row.subjectId)) continue;
    const index = row.revision - plan.before.revision - 1;
    const decision = plan.rows[index]?.decision;
    if (decision !== undefined) return yield* refused(decision, index, "label-taken", holder);
  }
});

// An impact with nothing to reach, such as an accepting Status, moves no repo and costs no query.
const reach = Effect.fn("Curation.reach")(function* (plan: Plan) {
  const db = yield* Db.Db;
  const reaching = plan.impacts.flatMap((impact, index) =>
    impact.keys.length + impact.subjects.length + impact.repos.length === 0 ? [] : [{ impact, index }],
  );
  const counts = yield* db.knowledge.reach(reaching.map(({ impact }) => impact));
  const moved = plan.impacts.map(() => 0);
  for (const [position, { index }] of reaching.entries()) moved[index] = counts[position] ?? 0;
  return moved;
});

const gate = (plan: Plan, moved: ReadonlyArray<number>, operator: boolean) => {
  if (operator) return Effect.void;
  const index = moved.findIndex((count) => count > operatorThreshold);
  const row = plan.rows[index] ?? plan.rows.at(-1);
  return index === -1 || row === undefined
    ? Effect.void
    : Effect.fail(new OperatorRequired({ decision: row.decision._tag, index, moved: moved[index] ?? 0 }));
};

const write = Effect.fn("Curation.write")(function* (plan: Plan, actor: string, operator: boolean) {
  const db = yield* Db.Db;
  const change = changeBetween(plan.before, plan.after);
  yield* mintedConflict(plan, change);
  const moved = yield* reach(plan);
  yield* gate(plan, moved, operator);
  const decided = yield* db.knowledge
    .decide({
      expected: plan.before.revision,
      rows: plan.rows.map((row, index) => rowOf(row, actor, plan.reasons[index] ?? "")),
      change,
    })
    .pipe(
      Effect.catchTags({
        KeyMinted: (error: KeyMinted) => {
          const owner = change.labelsAdded.find((row) => row.key === error.key && row.revision > plan.before.revision);
          const index = owner === undefined ? 0 : owner.revision - plan.before.revision - 1;
          const decision = plan.rows[index]?.decision;
          return decision === undefined
            ? Effect.die(error)
            : Effect.fail(refused(decision, index, "label-taken", SubjectId.make(error.holder)));
        },
      }),
    );
  const undone = plan.rows.flatMap((row) => (row.decision._tag === "Undo" ? [row.decision.revision] : []));
  return { revision: decided.revision, invalidated: decided.invalidated, moved, undone } satisfies Decided;
});

// Appends a batch of decisions at the revisions after expected, in one transaction. Each is checked against the fold
// before it and against the subjects projection minted, and one that moves more than operatorThreshold repos needs
// operator.
export const decide = Effect.fn("Curation.decide")(function* (input: {
  readonly decisions: ReadonlyArray<Proposed>;
  readonly expected: Revision;
  readonly actor: string;
  readonly operator: boolean;
}) {
  const db = yield* Db.Db;
  const state = yield* current;
  yield* checkHead(state, input.expected);
  const plan = yield* planDecisions(state, input.decisions, db.knowledge.allocate);
  return yield* write(plan, input.actor, input.operator);
});

// Takes one decision out of the fold, and with cascade every later decision that leans on it, each as its own Undo.
export const undo = Effect.fn("Curation.undo")(function* (input: {
  readonly revision: Revision;
  readonly cascade: boolean;
  readonly expected: Revision;
  readonly actor: string;
  readonly reason: string;
  readonly operator: boolean;
}) {
  const state = yield* current;
  yield* checkHead(state, input.expected);
  const plan = yield* planUndo(state, input.revision, input.cascade, input.reason);
  return yield* write(plan, input.actor, input.operator);
});

const placeholders = (count: number) =>
  Effect.succeed(Array.from({ length: count }, (_, index) => SubjectId.make(Number.MAX_SAFE_INTEGER - index)));

// What a batch, or one Undo, would do against the head now: the refusal or conflict decide or undo would fail with,
// the repos each decision moves, whether the operator must approve, and the repos it would mark stale. Writes nothing
// and allocates no subject.
export const preview = Effect.fn("Curation.preview")(function* (decisions: ReadonlyArray<Proposed>) {
  const db = yield* Db.Db;
  const state = yield* current;
  const [only] = decisions;
  const plan =
    decisions.length === 1 && only?.decision._tag === "Undo"
      ? yield* planUndo(state, only.decision.revision, only.decision.cascade, only.reason)
      : yield* planDecisions(state, decisions, placeholders);
  const change = changeBetween(plan.before, plan.after);
  yield* mintedConflict(plan, change);
  const moved = yield* reach(plan);
  const [reproject] = yield* db.knowledge.reach([change.invalidate]);
  return {
    head: state.revision,
    moved,
    operator: moved.some((count) => count > operatorThreshold),
    reproject: reproject ?? 0,
    undone: plan.rows.flatMap((row) => (row.decision._tag === "Undo" ? [row.decision.revision] : [])),
  } satisfies Preview;
});

export interface Proposal {
  readonly decision: Decision;
  readonly channel: Db.Variant["channel"];
  readonly evidence: string;
  // Repos the merge moves, the holders of the subject that stops being canonical.
  readonly moved: number;
  readonly examples: { readonly from: ReadonlyArray<RepoId>; readonly into: ReadonlyArray<RepoId> };
}

// Merge proposals ranked by the repos they move, from spelling variants: keys that differ by a separator, a plural s,
// or a js suffix. The usual term wins, else the shorter key. A plural merges into its singular only when the singular
// has at least 5% of the plural's repos. An unlisted subject is proposed only as the side that merges into a listed
// one. A pair the fold refuses, such as a keep-apart one, is never proposed. A judge decides each one.
export const queue = Effect.fn("Curation.queue")(function* (input: { readonly limit: number }) {
  const db = yield* Db.Db;
  const state = yield* current;
  const variants = yield* db.knowledge.variants;
  const info = new Map(
    (yield* db.knowledge.subjects([...new Set(variants.flatMap((pair) => [pair.a.subjectId, pair.b.subjectId]))])).map(
      (row) => [row.id, row] as const,
    ),
  );
  const seen = new Set<string>();
  const proposals: Array<Omit<Proposal, "examples">> = [];
  for (const variant of variants) {
    const a = info.get(variant.a.subjectId);
    const b = info.get(variant.b.subjectId);
    if (a === undefined || b === undefined) continue;
    const pair = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
    if (seen.has(pair)) continue;
    if (variant.channel === "plural" && a.repoCount < 0.05 * b.repoCount) continue;
    const aFirst =
      a.repoCount !== b.repoCount ? a.repoCount > b.repoCount : variant.a.key.length <= variant.b.key.length;
    const [into, from] = aFirst ? [a, b] : [b, a];
    const [intoKey, fromKey] = aFirst ? [variant.a.key, variant.b.key] : [variant.b.key, variant.a.key];
    if (into.repoCount < 2) continue;
    const decision: Decision = { _tag: "Merge", from: from.id, into: into.id };
    if (extend(state, [{ revision: Revision.make(state.revision + 1), decision, created: null }])._tag !== "Applied")
      continue;
    seen.add(pair);
    proposals.push({
      decision,
      channel: variant.channel,
      evidence: `"${fromKey}" and "${intoKey}" differ by ${variant.channel === "js" ? "a js suffix" : variant.channel === "plural" ? "a plural s" : "a separator"}`,
      moved: from.repoCount,
    });
  }
  const top = proposals.sort((x, y) => y.moved - x.moved).slice(0, input.limit);
  const examples = yield* db.knowledge.examples(
    top.flatMap(({ decision }) => (decision._tag === "Merge" ? [decision.from, decision.into] : [])),
    3,
  );
  return top.map(
    (proposal): Proposal => ({
      ...proposal,
      examples:
        proposal.decision._tag === "Merge"
          ? {
              from: examples.get(proposal.decision.from) ?? [],
              into: examples.get(proposal.decision.into) ?? [],
            }
          : { from: [], into: [] },
    }),
  );
});

// The decisions a seed batch needs against the vocabulary now. A second run after the first plans nothing.
export const planSeed = Effect.fn("Curation.planSeed")(function* (
  entries: ReadonlyArray<SeedEntry>,
  excluded: ReadonlySet<LabelKey>,
) {
  const db = yield* Db.Db;
  const state = yield* current;
  const keys = [
    ...new Set(
      entries.flatMap((entry) =>
        [entry.label, ...(entry.key === undefined ? [] : [entry.key]), ...entry.aliases].flatMap(
          (text) => labelKey(text) ?? [],
        ),
      ),
    ),
  ];
  const labels = yield* db.knowledge.labels(keys);
  const holders = new Map<LabelKey, SubjectId>();
  for (const label of labels) if (label.isDefault) holders.set(label.key, label.subjectId);
  const rows = yield* db.knowledge.subjects([...new Set(holders.values())]);
  const canonical = yield* db.knowledge.subjects([...new Set(rows.map((row) => row.canonicalId))]);
  const subjects = new Map<SubjectId, Holder>([...rows, ...canonical].map((row) => [row.id, row]));
  const plan = planSeeds({ entries, state, holders, subjects, excluded });
  return { head: state.revision, ...plan };
});

// Applies a seed plan as one batch at the head it was planned against.
export const seed = Effect.fn("Curation.seed")(function* (input: {
  readonly head: Revision;
  readonly decisions: ReadonlyArray<Planned>;
  readonly actor: string;
  readonly operator: boolean;
}) {
  if (input.decisions.length === 0) {
    return { revision: input.head, invalidated: 0, moved: [], undone: [] } satisfies Decided;
  }
  return yield* decide({
    decisions: input.decisions,
    expected: input.head,
    actor: input.actor,
    operator: input.operator,
  });
});

// The usage floor, run right after the nightly count: every candidate on at least three public repos from at least
// two owners becomes accepted, by Status decisions with actor rule:floor, so each acceptance shows in the log and can
// be undone. A batch that loses a race to another decision is planned again against the new head.
export const floor = Effect.fn("Curation.floor")(function* () {
  const db = yield* Db.Db;
  const ids = yield* db.knowledge.floor;
  let accepted = 0;
  for (let start = 0; start < ids.length; start += floorBatch) {
    const decisions = ids.slice(start, start + floorBatch).map(
      (subject): Proposed => ({
        decision: { _tag: "Status", subject, status: "accepted" },
        reason: "usage floor: at least 3 public repos from at least 2 owners",
      }),
    );
    const attempt = Effect.gen(function* () {
      const state = yield* current;
      const plan = yield* planDecisions(state, decisions, db.knowledge.allocate);
      return yield* write(plan, "rule:floor", false);
    });
    yield* attempt.pipe(Effect.retry({ while: (error) => error._tag === "StaleRevision", times: 3 }));
    accepted += decisions.length;
  }
  return { accepted };
});
