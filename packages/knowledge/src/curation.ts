import { type Decision, expandKey, type KnowledgeState, maxDepth, type SubjectStatus } from "./decisions.ts";
import type { Revision, SubjectId } from "./ids.ts";
import type { LabelKey } from "./label-key.ts";

export type ClosureVia = "split" | "parent" | "expand";

// A subject's presentation as the log decides it. label null keeps the row's own label: a minted subject no decision
// ever renamed shows its first surface form. origin is the decision that created the subject, or null for a mint.
export interface SubjectRow {
  readonly id: SubjectId;
  readonly label: string | null;
  readonly definition: string | null;
  readonly status: SubjectStatus;
  readonly repoId: number | null;
  readonly origin: Revision | null;
}

export interface LabelRow {
  readonly key: LabelKey;
  readonly subjectId: SubjectId;
  readonly isDefault: boolean;
  readonly revision: Revision;
}

export interface CanonicalRow {
  readonly originId: SubjectId;
  readonly canonicalId: SubjectId;
  readonly revision: Revision;
}

export interface EdgeRow {
  readonly ancestorId: SubjectId;
  readonly descendantId: SubjectId;
  readonly depth: 1 | 2 | 3;
  readonly via: ClosureVia;
  readonly revision: Revision;
}

// The rows of subjects, subject_labels, subject_canonical, and subject_closure that decisions own, a function of the
// fold. Minted labels and minted subjects' first labels stay outside it.
export interface Derived {
  readonly subjects: ReadonlyMap<SubjectId, SubjectRow>;
  readonly labels: ReadonlyMap<LabelKey, LabelRow>;
  readonly canonical: ReadonlyMap<SubjectId, CanonicalRow>;
  readonly closure: ReadonlyMap<string, EdgeRow>;
}

export interface Invalidation {
  // Keys that gained a label: repos that looked one up and found nothing project again.
  readonly keys: ReadonlyArray<LabelKey>;
  // Subjects whose holders project again.
  readonly subjects: ReadonlyArray<SubjectId>;
  // Repos whose corrections changed.
  readonly repos: ReadonlyArray<number>;
}

// What the database applies to go from one derived state to the next. refresh names the subjects whose
// subject_matches rows change, before their ancestors are added.
export interface Change {
  readonly created: ReadonlyArray<{
    readonly id: SubjectId;
    readonly label: string;
    readonly definition: string | null;
    readonly status: SubjectStatus;
    readonly repoId: number | null;
    readonly revision: Revision;
  }>;
  readonly presented: ReadonlyArray<{
    readonly id: SubjectId;
    readonly label: string | null;
    readonly definition: string | null;
    readonly status: SubjectStatus;
    readonly repoId: number | null;
  }>;
  readonly labelsAdded: ReadonlyArray<LabelRow>;
  readonly labelsRemoved: ReadonlyArray<{ readonly key: LabelKey; readonly subjectId: SubjectId }>;
  readonly merged: ReadonlyArray<CanonicalRow>;
  readonly unmerged: ReadonlyArray<SubjectId>;
  readonly edgesAdded: ReadonlyArray<EdgeRow>;
  readonly edgesRemoved: ReadonlyArray<{ readonly ancestorId: SubjectId; readonly descendantId: SubjectId }>;
  readonly refresh: ReadonlyArray<SubjectId>;
  readonly invalidate: Invalidation;
}

const viaRank: Record<ClosureVia, number> = { split: 3, parent: 2, expand: 1 };

const madeBy = (decision: Decision) =>
  decision._tag === "Create"
    ? { label: decision.label, definition: decision.definition }
    : decision._tag === "Split"
      ? { label: decision.into.label, definition: decision.into.definition }
      : null;

const presentedBy = (decision: Decision): SubjectId | null =>
  decision._tag === "Rename" || decision._tag === "Status" || decision._tag === "Link" ? decision.subject : null;

// Every pair a path of at most maxDepth edges joins. When paths differ, the row keeps the strongest via, since a
// comparison widens through a pair only when every edge on some path is a split, then the shortest, then the oldest.
const closureOf = (state: KnowledgeState): ReadonlyMap<string, EdgeRow> => {
  const edges = new Map<SubjectId, Array<{ to: SubjectId; via: ClosureVia; revision: Revision }>>();
  const add = (from: SubjectId, to: SubjectId, via: ClosureVia, revision: Revision | undefined) => {
    if (revision === undefined) return;
    edges.set(from, [...(edges.get(from) ?? []), { to, via, revision }]);
  };
  for (const [child, parent] of state.parents) add(parent, child, "parent", state.owners.parents.get(child));
  for (const [from, targets] of state.expands)
    for (const to of targets) add(from, to, "expand", state.owners.expands.get(expandKey(from, to)));
  for (const [broad, entries] of state.splits)
    for (const entry of entries) add(broad, entry.into, "split", entry.revision);

  const rows = new Map<string, EdgeRow>();
  const better = (a: EdgeRow, b: EdgeRow) =>
    viaRank[a.via] !== viaRank[b.via]
      ? viaRank[a.via] > viaRank[b.via]
      : a.depth !== b.depth
        ? a.depth < b.depth
        : a.revision < b.revision;
  const walk = (ancestor: SubjectId, node: SubjectId, depth: number, via: ClosureVia, revision: Revision) => {
    for (const edge of edges.get(node) ?? []) {
      const pathVia = viaRank[edge.via] < viaRank[via] ? edge.via : via;
      const pathRevision = edge.revision > revision ? edge.revision : revision;
      const row: EdgeRow = {
        ancestorId: ancestor,
        descendantId: edge.to,
        depth: (depth + 1) as 1 | 2 | 3,
        via: pathVia,
        revision: pathRevision,
      };
      const key = `${ancestor}:${edge.to}`;
      const current = rows.get(key);
      if (current === undefined || better(row, current)) rows.set(key, row);
      if (depth + 1 < maxDepth) walk(ancestor, edge.to, depth + 1, pathVia, pathRevision);
    }
  };
  for (const [from, out] of edges) {
    for (const edge of out) {
      const row: EdgeRow = {
        ancestorId: from,
        descendantId: edge.to,
        depth: 1,
        via: edge.via,
        revision: edge.revision,
      };
      const key = `${from}:${edge.to}`;
      const current = rows.get(key);
      if (current === undefined || better(row, current)) rows.set(key, row);
      walk(from, edge.to, 1, edge.via, edge.revision);
    }
  }
  return rows;
};

export const derive = (state: KnowledgeState): Derived => {
  const makers = new Map<SubjectId, { readonly revision: Revision; readonly decision: Decision }>();
  const bases = new Map<SubjectId, string>();
  const named = new Set<SubjectId>();
  for (const entry of state.log) {
    if (entry.created !== null) makers.set(entry.created, entry);
    const subject = presentedBy(entry.decision);
    if (subject === null) continue;
    named.add(subject);
    if (entry.base !== undefined && !bases.has(subject)) bases.set(subject, entry.base);
  }

  const subjects = new Map<SubjectId, SubjectRow>();
  for (const id of new Set([...makers.keys(), ...named])) {
    const maker = makers.get(id);
    const decided = state.subjects.get(id);
    const made = maker === undefined ? null : madeBy(maker.decision);
    if (maker !== undefined && made !== null && (state.retired.has(id) || decided === undefined)) {
      subjects.set(id, { id, ...made, status: "rejected", repoId: null, origin: maker.revision });
      continue;
    }
    subjects.set(id, {
      id,
      label: decided?.label ?? bases.get(id) ?? null,
      definition: decided?.definition ?? null,
      status: decided?.status ?? "candidate",
      repoId: decided?.repo ?? null,
      origin: maker?.revision ?? null,
    });
  }

  const labels = new Map<LabelKey, LabelRow>();
  for (const [key, subjectId] of state.labels) {
    const revision = state.owners.labels.get(key);
    if (revision !== undefined) labels.set(key, { key, subjectId, isDefault: true, revision });
  }
  const canonical = new Map<SubjectId, CanonicalRow>();
  for (const [originId, canonicalId] of state.canonical) {
    const revision = state.owners.canonical.get(originId);
    if (revision !== undefined) canonical.set(originId, { originId, canonicalId, revision });
  }
  return { subjects, labels, canonical, closure: closureOf(state) };
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const changed = <K, V>(before: ReadonlyMap<K, V>, after: ReadonlyMap<K, V>) => ({
  removed: [...before].filter(([key, row]) => !same(after.get(key), row)),
  added: [...after].filter(([key, row]) => !same(before.get(key), row)),
});

const classes = (state: KnowledgeState, ids: Iterable<SubjectId>): ReadonlySet<SubjectId> => {
  const roots = new Set([...ids].map((id) => state.canonical.get(id) ?? id));
  return new Set([
    ...roots,
    ...[...state.canonical].flatMap(([origin, survivor]) => (roots.has(survivor) ? [origin] : [])),
  ]);
};

const splitDescendants = (state: KnowledgeState, ids: Iterable<SubjectId>): ReadonlyArray<SubjectId> => {
  const found: Array<SubjectId> = [];
  let frontier = [...ids];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    frontier = frontier.flatMap((id) => (state.splits.get(id) ?? []).map((entry) => entry.into));
    found.push(...frontier);
  }
  return found;
};

const splitsKey = (state: KnowledgeState, broad: SubjectId) =>
  (state.splits.get(broad) ?? []).map((entry) => `${entry.revision}>${entry.into}`).join(",");

// The holders whose projection can read differently after the fold moves from one state to the next, by the table in
// docs/knowledge.md. A key's minted holder, when a decision label now outranks it, needs the database, which adds it.
const invalidation = (before: KnowledgeState, after: KnowledgeState): Invalidation => {
  const keys: Array<LabelKey> = [];
  const subjects = new Set<SubjectId>();
  for (const [key, holder] of after.labels) if (before.labels.get(key) !== holder) keys.push(key);
  for (const [key, holder] of before.labels) if (after.labels.get(key) !== holder) subjects.add(holder);

  const moved = movedOrigins(before, after);
  if (moved.length > 0) {
    const members = new Set([...classes(before, moved), ...classes(after, moved)]);
    if ([...members].some((id) => before.splits.has(id) || after.splits.has(id))) {
      for (const id of [...members, ...splitDescendants(before, members), ...splitDescendants(after, members)])
        subjects.add(id);
    }
  }

  for (const broad of new Set([...before.splits.keys(), ...after.splits.keys()])) {
    if (splitsKey(before, broad) === splitsKey(after, broad)) continue;
    const children = [...(before.splits.get(broad) ?? []), ...(after.splits.get(broad) ?? [])].map(
      (entry) => entry.into,
    );
    const holders = [
      broad,
      ...[...before.canonical, ...after.canonical].flatMap(([origin, survivor]) =>
        survivor === broad ? [origin] : [],
      ),
      ...children,
      ...splitDescendants(before, children),
      ...splitDescendants(after, children),
    ];
    for (const id of holders) subjects.add(id);
  }

  const repos = [...new Set([...before.corrections.keys(), ...after.corrections.keys()])].filter(
    (repo) =>
      before.corrections.get(repo) !== after.corrections.get(repo) &&
      !same(before.corrections.get(repo), after.corrections.get(repo)),
  );
  return {
    keys: keys.sort(),
    subjects: [...subjects].sort((a, b) => a - b),
    repos: repos.sort((a, b) => a - b),
  };
};

const movedOrigins = (before: KnowledgeState, after: KnowledgeState): ReadonlyArray<SubjectId> => [
  ...new Set(
    [...before.canonical.keys(), ...after.canonical.keys()].filter(
      (origin) => before.canonical.get(origin) !== after.canonical.get(origin),
    ),
  ),
];

const rowChanges = (before: Derived, after: Derived) => {
  const created: Array<Change["created"][number]> = [];
  const presented: Array<Change["presented"][number]> = [];
  for (const [id, row] of after.subjects) {
    const previous = before.subjects.get(id);
    if (previous !== undefined && same(previous, row)) continue;
    if (previous === undefined && row.origin !== null && row.label !== null) {
      created.push({
        id,
        label: row.label,
        definition: row.definition,
        status: row.status,
        repoId: row.repoId,
        revision: row.origin,
      });
    } else {
      presented.push({ id, label: row.label, definition: row.definition, status: row.status, repoId: row.repoId });
    }
  }
  const labels = changed(before.labels, after.labels);
  const canonical = changed(before.canonical, after.canonical);
  const closure = changed(before.closure, after.closure);
  return {
    created,
    presented,
    labelsAdded: labels.added.map(([, row]) => row),
    labelsRemoved: labels.removed.map(([key, row]) => ({ key, subjectId: row.subjectId })),
    merged: canonical.added.map(([, row]) => row),
    unmerged: canonical.removed.filter(([origin]) => !after.canonical.has(origin)).map(([origin]) => origin),
    edgesAdded: closure.added.map(([, row]) => row),
    edgesRemoved: closure.removed.map(([, row]) => ({ ancestorId: row.ancestorId, descendantId: row.descendantId })),
  };
};

// The change that takes the database from one fold to a later one: the derived rows that differ, the subjects whose
// filter rows to rebuild, and the repos to mark stale.
export const changeBetween = (before: KnowledgeState, after: KnowledgeState): Change => {
  const from = derive(before);
  const to = derive(after);
  const rows = rowChanges(from, to);
  const refresh = new Set<SubjectId>([
    ...rows.created.map((row) => row.id),
    ...rows.presented.map((row) => row.id),
    ...rows.unmerged,
    ...rows.merged.map((row) => row.originId),
    ...[...from.canonical.values(), ...to.canonical.values()]
      .filter((row) => !same(from.canonical.get(row.originId), to.canonical.get(row.originId)))
      .map((row) => row.canonicalId),
    ...[...rows.edgesAdded, ...rows.edgesRemoved].flatMap((row) => [row.ancestorId, row.descendantId]),
  ]);
  return {
    ...rows,
    refresh: [...refresh].sort((a, b) => a - b),
    invalidate: invalidation(before, after),
  };
};

// What one step of the fold moves, for the impact count and the operator gate: the keys it labels, the subjects whose
// holders project again or whose filter changes meaning, and the corrected repos. A merge moves its moving class even
// when no split rule makes the holders project again, and a status moves its subject when it rejects or restores it.
export const impact = (before: KnowledgeState, after: KnowledgeState): Invalidation => {
  const invalidated = invalidation(before, after);
  const rejected = (state: KnowledgeState, id: SubjectId) =>
    state.retired.has(id) || state.subjects.get(id)?.status === "rejected";
  const flipped = [...after.subjects.keys(), ...after.retired].filter(
    (id) => rejected(before, id) !== rejected(after, id),
  );
  const subjects = new Set([...invalidated.subjects, ...movedOrigins(before, after), ...flipped]);
  return { ...invalidated, subjects: [...subjects].sort((a, b) => a - b) };
};
