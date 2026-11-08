import * as Schema from "effect/Schema";
import { Atom, formatAtom } from "./atom.ts";
import { Revision, SelectionId, SubjectId } from "./ids.ts";
import { LabelKey, labelKey } from "./label-key.ts";
import { reservedKeys } from "./registry.ts";

// Sends evidence on a broad subject to a narrower one. A claim moves when any condition holds: its own label key is
// listed, every word of one terms entry occurs in its quote or term, or its repo is pinned. Everything else stays broad.
export const SplitRule = Schema.Struct({
  labels: Schema.Array(LabelKey),
  terms: Schema.Array(Schema.NonEmptyArray(Schema.String)),
  repos: Schema.Array(Schema.Int),
}).check(
  Schema.makeFilter((rule) => rule.labels.length + rule.terms.length + rule.repos.length > 0, {
    expected: "a rule with at least one condition",
  }),
);
export type SplitRule = typeof SplitRule.Type;

export const SubjectStatus = Schema.Literals(["candidate", "accepted", "rejected"]);
export type SubjectStatus = typeof SubjectStatus.Type;

const NewSubject = Schema.Struct({ label: Schema.String, definition: Schema.String });

// One curation step. docs/knowledge.md says what each one means.
export const Decision = Schema.Union([
  Schema.TaggedStruct("Create", {
    label: Schema.String,
    definition: Schema.String,
    aliases: Schema.Array(Schema.String),
    status: SubjectStatus,
  }),
  Schema.TaggedStruct("Merge", { from: SubjectId, into: SubjectId }),
  Schema.TaggedStruct("Split", { subject: SubjectId, into: NewSubject, rule: SplitRule }),
  Schema.TaggedStruct("Rename", {
    subject: SubjectId,
    label: Schema.optionalKey(Schema.String),
    definition: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("Alias", { subject: SubjectId, label: Schema.String, add: Schema.Boolean }),
  Schema.TaggedStruct("Parent", { child: SubjectId, parent: Schema.NullOr(SubjectId) }),
  Schema.TaggedStruct("Expand", { from: SubjectId, to: SubjectId, add: Schema.Boolean }),
  Schema.TaggedStruct("KeepApart", { a: SubjectId, b: SubjectId, add: Schema.Boolean }),
  Schema.TaggedStruct("Status", { subject: SubjectId, status: SubjectStatus }),
  Schema.TaggedStruct("Link", { subject: SubjectId, repo: Schema.NullOr(Schema.Int) }),
  Schema.TaggedStruct("Correct", { repo: Schema.Int, atom: Atom, present: Schema.Boolean }),
  Schema.TaggedStruct("Publish", { selection: SelectionId, slug: Schema.String, title: Schema.String }),
  Schema.TaggedStruct("Retire", { selection: SelectionId, redirectTo: Schema.NullOr(SelectionId) }),
  Schema.TaggedStruct("Undo", { revision: Revision, cascade: Schema.Boolean }),
]);
export type Decision = typeof Decision.Type;

// A decision as the log stores it. created is the subject a Create or Split made, allocated by the database inside
// the decision's transaction, so folding the log is deterministic.
export interface StoredDecision {
  readonly revision: Revision;
  readonly decision: Decision;
  readonly created: SubjectId | null;
}

// What decisions set on a subject. Null is untouched: a minted subject keeps its first surface form and is a candidate.
export interface SubjectState {
  readonly label: string | null;
  readonly definition: string | null;
  readonly status: SubjectStatus | null;
  readonly repo: number | null;
}

export interface SplitEntry {
  readonly revision: Revision;
  readonly into: SubjectId;
  readonly rule: SplitRule;
}

export interface Correction {
  readonly atom: Atom;
  readonly present: boolean;
}

// The curated state, a pure function of the log. Subjects a projection minted appear only once a decision names them.
export interface KnowledgeState {
  readonly revision: Revision;
  readonly log: ReadonlyArray<StoredDecision>;
  // Revisions an active Undo removes from the fold.
  readonly undone: ReadonlySet<Revision>;
  // Active revisions that were invalid against the state before them, so the fold skipped them.
  readonly skipped: ReadonlySet<Revision>;
  // Subjects whose creating decision is undone or skipped. Their IDs are never reused and match nothing.
  readonly retired: ReadonlySet<SubjectId>;
  readonly subjects: ReadonlyMap<SubjectId, SubjectState>;
  // Decision-owned default labels. Minted labels live only in the database.
  readonly labels: ReadonlyMap<LabelKey, SubjectId>;
  // Merged origin to survivor, one hop.
  readonly canonical: ReadonlyMap<SubjectId, SubjectId>;
  readonly parents: ReadonlyMap<SubjectId, SubjectId>;
  readonly expands: ReadonlyMap<SubjectId, ReadonlySet<SubjectId>>;
  // Each broad subject's split rules, in revision order.
  readonly splits: ReadonlyMap<SubjectId, ReadonlyArray<SplitEntry>>;
  // Unordered pairs, written "a:b" with a < b.
  readonly keepApart: ReadonlySet<string>;
  readonly corrections: ReadonlyMap<number, ReadonlyArray<Correction>>;
}

// Refusals the state alone can prove. Namespace, slug, listing, and published-selection checks need the database.
export type InvalidReason =
  | "keep-apart"
  | "cycle"
  | "too-deep"
  | "not-live"
  | "link-conflict"
  | "label-taken"
  | "reserved-label"
  | "role-mismatch";

export interface Invalid {
  readonly revision: Revision;
  readonly reason: InvalidReason;
}

export type Applied =
  | { readonly _tag: "Applied"; readonly state: KnowledgeState }
  | { readonly _tag: "Invalid"; readonly invalid: Invalid }
  // An Undo that would make later decisions invalid. The caller undoes them first, newest first, or refuses.
  | { readonly _tag: "Conflict"; readonly revisions: ReadonlyArray<Revision> };

// Closure paths, across Parent, Expand, and Split edges together, are at most this long.
export const maxDepth = 3;

interface Draft {
  readonly retired: Set<SubjectId>;
  readonly subjects: Map<SubjectId, SubjectState>;
  readonly labels: Map<LabelKey, SubjectId>;
  readonly canonical: Map<SubjectId, SubjectId>;
  readonly parents: Map<SubjectId, SubjectId>;
  readonly expands: Map<SubjectId, ReadonlySet<SubjectId>>;
  readonly splits: Map<SubjectId, ReadonlyArray<SplitEntry>>;
  readonly keepApart: Set<string>;
  readonly corrections: Map<number, ReadonlyArray<Correction>>;
}

// Inner collections are replaced on write, never mutated, so a draft shares them safely with the state it came from.
const draftOf = (state: KnowledgeState): Draft => ({
  retired: new Set(state.retired),
  subjects: new Map(state.subjects),
  labels: new Map(state.labels),
  canonical: new Map(state.canonical),
  parents: new Map(state.parents),
  expands: new Map(state.expands),
  splits: new Map(state.splits),
  keepApart: new Set(state.keepApart),
  corrections: new Map(state.corrections),
});

export const empty: KnowledgeState = {
  revision: Revision.make(0),
  log: [],
  undone: new Set(),
  skipped: new Set(),
  retired: new Set(),
  subjects: new Map(),
  labels: new Map(),
  canonical: new Map(),
  parents: new Map(),
  expands: new Map(),
  splits: new Map(),
  keepApart: new Set(),
  corrections: new Map(),
};

const untouched: SubjectState = { label: null, definition: null, status: null, repo: null };

const pair = (a: SubjectId, b: SubjectId) => (a < b ? `${a}:${b}` : `${b}:${a}`);

const successors = (draft: Draft, node: SubjectId): ReadonlyArray<SubjectId> => [
  ...[...draft.parents].flatMap(([child, parent]) => (parent === node ? [child] : [])),
  ...(draft.expands.get(node) ?? []),
  ...(draft.splits.get(node) ?? []).map((entry) => entry.into),
];

const predecessors = (draft: Draft, node: SubjectId): ReadonlyArray<SubjectId> => [
  ...(draft.parents.has(node) ? [draft.parents.get(node) as SubjectId] : []),
  ...[...draft.expands].flatMap(([from, to]) => (to.has(node) ? [from] : [])),
  ...[...draft.splits].flatMap(([broad, entries]) => (entries.some((entry) => entry.into === node) ? [broad] : [])),
];

// The graph is acyclic and at most maxDepth deep, so plain recursion stays shallow.
const longest = (draft: Draft, node: SubjectId, next: typeof successors): number =>
  Math.max(0, ...next(draft, node).map((other) => 1 + longest(draft, other, next)));

const reaches = (draft: Draft, from: SubjectId, to: SubjectId): boolean =>
  from === to || successors(draft, from).some((next) => reaches(draft, next, to));

const edgeRefusal = (draft: Draft, from: SubjectId, to: SubjectId): InvalidReason | null => {
  if (reaches(draft, to, from)) return "cycle";
  return longest(draft, from, predecessors) + 1 + longest(draft, to, successors) > maxDepth ? "too-deep" : null;
};

const classOf = (draft: Draft, id: SubjectId): ReadonlyArray<SubjectId> => [
  id,
  ...[...draft.canonical].flatMap(([origin, survivor]) => (survivor === id ? [origin] : [])),
];

const live = (draft: Draft, ...ids: ReadonlyArray<SubjectId>) => ids.every((id) => !draft.retired.has(id));
const liveCanonical = (draft: Draft, ...ids: ReadonlyArray<SubjectId>) =>
  live(draft, ...ids) && ids.every((id) => !draft.canonical.has(id));

// The keys a decision gives the owner, or why it cannot: a key no subject may hold, or one another subject holds.
const keysFor = (
  draft: Draft,
  owner: SubjectId,
  texts: ReadonlyArray<string>,
): ReadonlyArray<LabelKey> | InvalidReason => {
  const keys: Array<LabelKey> = [];
  for (const text of texts) {
    const key = labelKey(text);
    if (key === null || reservedKeys.has(key)) return "reserved-label";
    const holder = draft.labels.get(key);
    if (holder !== undefined && holder !== owner) return "label-taken";
    keys.push(key);
  }
  return keys;
};

const present = (draft: Draft, id: SubjectId) => draft.subjects.get(id) ?? untouched;

// Validates one decision against the draft, then applies it. The draft changes only when the result is null.
const applyOne = (draft: Draft, stored: StoredDecision): InvalidReason | null => {
  const { decision, created, revision } = stored;
  switch (decision._tag) {
    case "Create": {
      if (created === null) return "not-live";
      const keys = keysFor(draft, created, [decision.label, ...decision.aliases]);
      if (typeof keys === "string") return keys;
      draft.subjects.set(created, {
        label: decision.label,
        definition: decision.definition,
        status: decision.status,
        repo: null,
      });
      for (const key of keys) draft.labels.set(key, created);
      return null;
    }
    case "Merge": {
      const { from, into } = decision;
      if (!liveCanonical(draft, from, into)) return "not-live";
      if (from === into) return "cycle";
      const moving = classOf(draft, from);
      const staying = classOf(draft, into);
      if (moving.some((a) => staying.some((b) => draft.keepApart.has(pair(a, b))))) return "keep-apart";
      const repos = new Set([...moving, ...staying].flatMap((id) => present(draft, id).repo ?? []));
      if (repos.size > 1) return "link-conflict";
      for (const origin of moving) draft.canonical.set(origin, into);
      return null;
    }
    case "Split": {
      if (created === null || !liveCanonical(draft, decision.subject)) return "not-live";
      const keys = keysFor(draft, created, [decision.into.label]);
      if (typeof keys === "string") return keys;
      const edge = edgeRefusal(draft, decision.subject, created);
      if (edge !== null) return edge;
      draft.subjects.set(created, {
        label: decision.into.label,
        definition: decision.into.definition,
        status: "candidate",
        repo: null,
      });
      for (const key of keys) draft.labels.set(key, created);
      draft.splits.set(decision.subject, [
        ...(draft.splits.get(decision.subject) ?? []),
        { revision, into: created, rule: decision.rule },
      ]);
      return null;
    }
    case "Rename": {
      if (!liveCanonical(draft, decision.subject)) return "not-live";
      const keys = keysFor(draft, decision.subject, decision.label === undefined ? [] : [decision.label]);
      if (typeof keys === "string") return keys;
      const current = present(draft, decision.subject);
      draft.subjects.set(decision.subject, {
        ...current,
        label: decision.label ?? current.label,
        definition: decision.definition ?? current.definition,
      });
      for (const key of keys) draft.labels.set(key, decision.subject);
      return null;
    }
    case "Alias": {
      if (!liveCanonical(draft, decision.subject)) return "not-live";
      if (!decision.add) {
        const key = labelKey(decision.label);
        if (key === null || draft.labels.get(key) !== decision.subject) return "not-live";
        draft.labels.delete(key);
        return null;
      }
      const keys = keysFor(draft, decision.subject, [decision.label]);
      if (typeof keys === "string") return keys;
      for (const key of keys) draft.labels.set(key, decision.subject);
      return null;
    }
    case "Parent": {
      const { child, parent } = decision;
      if (!liveCanonical(draft, child) || (parent !== null && !liveCanonical(draft, parent))) return "not-live";
      const previous = draft.parents.get(child);
      draft.parents.delete(child);
      const edge = parent === null ? null : edgeRefusal(draft, parent, child);
      if (edge !== null) {
        if (previous !== undefined) draft.parents.set(child, previous);
        return edge;
      }
      if (parent !== null) draft.parents.set(child, parent);
      return null;
    }
    case "Expand": {
      const { from, to } = decision;
      if (!liveCanonical(draft, from, to)) return "not-live";
      const targets = draft.expands.get(from) ?? new Set<SubjectId>();
      if (!decision.add) {
        draft.expands.set(from, new Set([...targets].filter((id) => id !== to)));
        return null;
      }
      if (targets.has(to)) return null;
      const edge = edgeRefusal(draft, from, to);
      if (edge !== null) return edge;
      draft.expands.set(from, new Set([...targets, to]));
      return null;
    }
    case "KeepApart": {
      const { a, b } = decision;
      if (!live(draft, a, b)) return "not-live";
      if (!decision.add) {
        draft.keepApart.delete(pair(a, b));
        return null;
      }
      if ((draft.canonical.get(a) ?? a) === (draft.canonical.get(b) ?? b)) return "keep-apart";
      draft.keepApart.add(pair(a, b));
      return null;
    }
    case "Status": {
      if (!liveCanonical(draft, decision.subject)) return "not-live";
      draft.subjects.set(decision.subject, { ...present(draft, decision.subject), status: decision.status });
      return null;
    }
    case "Link": {
      const { subject, repo } = decision;
      if (!liveCanonical(draft, subject)) return "not-live";
      if (repo !== null) {
        const members = classOf(draft, subject);
        const elsewhere = [...draft.subjects].some(([id, state]) => state.repo === repo && !members.includes(id));
        const merged = members.some((id) => (present(draft, id).repo ?? repo) !== repo);
        if (elsewhere || merged) return "link-conflict";
      }
      draft.subjects.set(subject, { ...present(draft, subject), repo });
      return null;
    }
    case "Correct": {
      const { atom } = decision;
      if (atom.role === "any") return "role-mismatch";
      if (atom.value.dim === "subject" && !live(draft, atom.value.id)) return "not-live";
      const key = formatAtom(atom);
      draft.corrections.set(decision.repo, [
        ...(draft.corrections.get(decision.repo) ?? []).filter((correction) => formatAtom(correction.atom) !== key),
        { atom, present: decision.present },
      ]);
      return null;
    }
    case "Publish":
    case "Retire":
      // Selections live in the database, which checks these.
      return null;
    case "Undo":
      // fold and apply handle an Undo by folding the log without its target.
      return "not-live";
  }
};

const freeze = (
  draft: Draft,
  log: ReadonlyArray<StoredDecision>,
  undone: ReadonlySet<Revision>,
  skipped: ReadonlySet<Revision>,
): KnowledgeState => ({
  revision: log.at(-1)?.revision ?? Revision.make(0),
  log,
  undone,
  skipped,
  ...draft,
});

// The state a log describes. An active Undo removes its target, so undoing an Undo restores it. The remaining
// decisions apply in revision order, and one invalid against the state before it is skipped and reported, with any
// subject it created retired.
export const fold = (
  decisions: ReadonlyArray<StoredDecision>,
): { readonly state: KnowledgeState; readonly invalid: ReadonlyArray<Invalid> } => {
  const log = [...decisions].sort((a, b) => a.revision - b.revision);
  const undone = new Set<Revision>();
  for (const stored of [...log].reverse()) {
    if (stored.decision._tag === "Undo" && !undone.has(stored.revision)) undone.add(stored.decision.revision);
  }
  const draft = draftOf(empty);
  for (const stored of log)
    if (undone.has(stored.revision) && stored.created !== null) draft.retired.add(stored.created);
  const invalid: Array<Invalid> = [];
  for (const stored of log) {
    if (stored.decision._tag === "Undo" || undone.has(stored.revision)) continue;
    const reason = applyOne(draft, stored);
    if (reason === null) continue;
    invalid.push({ revision: stored.revision, reason });
    if (stored.created !== null) draft.retired.add(stored.created);
  }
  return { state: freeze(draft, log, undone, new Set(invalid.map((entry) => entry.revision))), invalid };
};

// One more decision on top of the state, as the log would fold it. An Undo folds the log without its target and
// reports a Conflict when that turns later decisions invalid.
export const apply = (state: KnowledgeState, stored: StoredDecision): Applied => {
  const refuse = (reason: InvalidReason): Applied => ({
    _tag: "Invalid",
    invalid: { revision: stored.revision, reason },
  });
  if (stored.revision <= state.revision) return refuse("not-live");
  if (stored.decision._tag === "Undo") {
    const target = stored.decision.revision;
    const known = state.log.some((entry) => entry.revision === target);
    if (!known || state.undone.has(target) || state.skipped.has(target)) return refuse("not-live");
    const next = fold([...state.log, stored]);
    const broken = next.invalid.map((entry) => entry.revision).filter((revision) => !state.skipped.has(revision));
    return broken.length > 0 ? { _tag: "Conflict", revisions: broken } : { _tag: "Applied", state: next.state };
  }
  const draft = draftOf(state);
  const reason = applyOne(draft, stored);
  if (reason !== null) return refuse(reason);
  return { _tag: "Applied", state: freeze(draft, [...state.log, stored], state.undone, state.skipped) };
};
