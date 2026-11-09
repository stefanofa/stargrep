import { describe, expect, test } from "bun:test";
import { type Change, changeBetween, derive, impact } from "./curation.ts";
import { run } from "./decisions.fixture.ts";
import {
  apply,
  type Decision,
  empty,
  fold,
  type KnowledgeState,
  rules,
  type StoredDecision,
  undoing,
} from "./decisions.ts";
import { Revision, SubjectId } from "./ids.ts";
import { type LabelKey, labelKey } from "./label-key.ts";

const s = (id: number) => SubjectId.make(id);
const r = (n: number) => Revision.make(n);
const key = (text: string) => labelKey(text) as LabelKey;

interface Tables {
  readonly subjects: Map<number, { label: string; definition: string | null; status: string; repoId: number | null }>;
  readonly labels: Map<string, { subjectId: number; revision: number }>;
  readonly canonical: Map<number, { canonicalId: number; revision: number }>;
  readonly closure: Map<string, { depth: number; via: string; revision: number }>;
}

// The decision-owned rows as the database would hold them, with the fixture's six minted subjects.
const minted = (): Tables => ({
  subjects: new Map(
    [1, 2, 3, 4, 5, 6].map((id) => [
      id,
      { label: `minted ${id}`, definition: null, status: "candidate", repoId: null },
    ]),
  ),
  labels: new Map(),
  canonical: new Map(),
  closure: new Map(),
});

// Applies a change the way the decide query does: removals before additions, and a null label keeps the row's own.
const write = (tables: Tables, change: Change) => {
  for (const { label, definition, status, repoId, id } of change.created)
    tables.subjects.set(id, { label, definition, status, repoId });
  for (const { label, definition, status, repoId, id } of change.presented) {
    const current = tables.subjects.get(id);
    tables.subjects.set(id, { label: label ?? current?.label ?? "missing", definition, status, repoId });
  }
  for (const row of change.labelsRemoved) {
    if (tables.labels.get(row.key)?.subjectId === row.subjectId) tables.labels.delete(row.key);
  }
  for (const row of change.labelsAdded)
    tables.labels.set(row.key, { subjectId: row.subjectId, revision: row.revision });
  for (const origin of change.unmerged) tables.canonical.delete(origin);
  for (const row of change.merged)
    tables.canonical.set(row.originId, { canonicalId: row.canonicalId, revision: row.revision });
  for (const row of change.edgesRemoved) tables.closure.delete(`${row.ancestorId}:${row.descendantId}`);
  for (const row of change.edgesAdded) {
    tables.closure.set(`${row.ancestorId}:${row.descendantId}`, {
      depth: row.depth,
      via: row.via,
      revision: row.revision,
    });
  }
};

const expected = (state: KnowledgeState): Tables => {
  const derived = derive(state);
  const tables = minted();
  for (const row of derived.subjects.values()) {
    tables.subjects.set(row.id, {
      label: row.label ?? `minted ${row.id}`,
      definition: row.definition,
      status: row.status,
      repoId: row.repoId,
    });
  }
  for (const row of derived.labels.values())
    tables.labels.set(row.key, { subjectId: row.subjectId, revision: row.revision });
  for (const row of derived.canonical.values())
    tables.canonical.set(row.originId, { canonicalId: row.canonicalId, revision: row.revision });
  for (const [pair, row] of derived.closure)
    tables.closure.set(pair, { depth: row.depth, via: row.via, revision: row.revision });
  return tables;
};

const sorted = (tables: Tables) =>
  Object.fromEntries(
    Object.entries(tables).map(([name, map]) => [
      name,
      [...(map as Map<unknown, unknown>)].map((entry) => JSON.stringify(entry)).sort(),
    ]),
  );

const sequence = (...decisions: ReadonlyArray<Decision | readonly [Decision, number]>) => {
  let state = empty;
  for (const entry of decisions) {
    const [decision, created] = Array.isArray(entry) ? entry : [entry as Decision, null];
    const result = apply(state, {
      revision: r(state.revision + 1),
      decision,
      created: created === null ? null : s(created),
    });
    if (result._tag !== "Applied") throw new Error(`${decision._tag} was ${result._tag}`);
    state = result.state;
  }
  return state;
};
const create = (label: string, id: number, aliases: ReadonlyArray<string> = []) =>
  [{ _tag: "Create", label, definition: "", aliases, status: "accepted" }, id] as const;
const split = (subject: number, label: string, id: number) =>
  [
    {
      _tag: "Split",
      subject: s(subject),
      into: { label, definition: "" },
      rule: { labels: [], terms: [["browser"]], repos: [] },
    },
    id,
  ] as const;
const undo = (state: KnowledgeState, target: number) => {
  const result = apply(state, {
    revision: r(state.revision + 1),
    decision: { _tag: "Undo", revision: r(target), cascade: false },
    created: null,
  });
  if (result._tag !== "Applied") throw new Error(`undo was ${result._tag}`);
  return result.state;
};

describe("changeBetween", () => {
  test("applying each decision's change keeps the tables equal to the fold, at every step of 150 random sequences", () => {
    let steps = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const tables = minted();
      let previous: KnowledgeState = empty;
      run(seed, 50, (state) => {
        write(tables, changeBetween(previous, state));
        expect(sorted(tables)).toEqual(sorted(expected(state)));
        previous = state;
        steps++;
      });
    }
    expect(steps).toBeGreaterThan(3000);
  });

  test("one change across a whole batch equals the changes of its steps", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const stepwise = minted();
      let previous: KnowledgeState = empty;
      const { state } = run(seed, 40, (next) => {
        write(stepwise, changeBetween(previous, next));
        previous = next;
      });
      const batched = minted();
      write(batched, changeBetween(empty, state));
      expect(sorted(batched)).toEqual(sorted(stepwise));
    }
  });

  test("an undo, then the undo of that undo, puts every row back with the revision that owns it", () => {
    let checked = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const { state } = run(seed, 30, () => {});
      for (const target of state.log) {
        const undone = undoing(state, target.revision, false, r(state.revision + 1));
        if (undone._tag !== "Applied") continue;
        const redone = undoing(undone.state, r(state.revision + 1), false, r(state.revision + 2));
        if (redone._tag !== "Applied") continue;
        const tables = expected(state);
        write(tables, changeBetween(state, undone.state));
        write(tables, changeBetween(undone.state, redone.state));
        expect(sorted(tables)).toEqual(sorted(expected(state)));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  test("the closure keeps every path of three edges or fewer, with its weakest edge and the decision that finished it", () => {
    const state = sequence(
      split(1, "child", 10),
      { _tag: "Parent", child: s(1), parent: s(2) },
      { _tag: "Expand", from: s(3), to: s(2), add: true },
    );
    expect(
      [...derive(state).closure.values()].sort(
        (a, b) => a.ancestorId - b.ancestorId || a.descendantId - b.descendantId,
      ),
    ).toEqual([
      { ancestorId: s(1), descendantId: s(10), depth: 1, via: "split", revision: r(1) },
      { ancestorId: s(2), descendantId: s(1), depth: 1, via: "parent", revision: r(2) },
      { ancestorId: s(2), descendantId: s(10), depth: 2, via: "parent", revision: r(2) },
      { ancestorId: s(3), descendantId: s(1), depth: 2, via: "expand", revision: r(3) },
      { ancestorId: s(3), descendantId: s(2), depth: 1, via: "expand", revision: r(3) },
      { ancestorId: s(3), descendantId: s(10), depth: 3, via: "expand", revision: r(3) },
    ]);
  });

  test("undoing a create rejects its subject and drops its labels, and re-projects their holders", () => {
    const created = sequence(create("alpha", 10, ["alef"]));
    const change = changeBetween(created, undo(created, 1));
    expect(change.presented).toEqual([{ id: s(10), label: "alpha", definition: "", status: "rejected", repoId: null }]);
    expect(change.labelsRemoved.map((row) => row.key).sort()).toEqual([key("alef"), key("alpha")]);
    expect(change.invalidate).toEqual({ keys: [], subjects: [s(10)], repos: [] });
    expect(change.refresh).toEqual([s(10)]);
  });

  test("a rename of a minted subject records its first label, and undoing the rename puts it back", () => {
    const renamed = fold([
      { revision: r(1), decision: { _tag: "Rename", subject: s(4), label: "Four" }, created: null, base: "four-ish" },
    ]).state;
    expect(changeBetween(empty, renamed)).toMatchObject({
      presented: [{ id: s(4), label: "Four", definition: null, status: "candidate", repoId: null }],
      labelsAdded: [{ key: key("four"), subjectId: s(4), isDefault: true, revision: r(1) }],
      invalidate: { keys: [key("four")], subjects: [], repos: [] },
    });
    expect(changeBetween(renamed, undo(renamed, 1))).toMatchObject({
      presented: [{ id: s(4), label: "four-ish" }],
      labelsRemoved: [{ key: key("four"), subjectId: s(4) }],
      invalidate: { keys: [], subjects: [s(4)], repos: [] },
    });
  });

  test("a merge re-projects nothing unless a split rule is in play, and then both classes and the split children", () => {
    const plain = sequence({ _tag: "Merge", from: s(1), into: s(2) });
    expect(changeBetween(empty, plain).invalidate).toEqual({ keys: [], subjects: [], repos: [] });
    expect(impact(empty, plain).subjects).toEqual([s(1)]);

    const ruled = sequence(
      split(2, "child", 10),
      { _tag: "Merge", from: s(3), into: s(4) },
      { _tag: "Merge", from: s(4), into: s(2) },
    );
    const before = sequence(split(2, "child", 10), { _tag: "Merge", from: s(3), into: s(4) });
    expect(changeBetween(before, ruled).invalidate.subjects).toEqual([s(2), s(3), s(4), s(10)]);
    expect(changeBetween(ruled, undo(ruled, 3)).invalidate.subjects).toEqual([s(2), s(3), s(4), s(10)]);
  });

  test("a split re-projects the broad subject, the IDs merged into it, and the child", () => {
    const merged = sequence({ _tag: "Merge", from: s(5), into: s(1) });
    const splitState = sequence({ _tag: "Merge", from: s(5), into: s(1) }, split(1, "child", 10));
    const change = changeBetween(merged, splitState);
    expect(change.invalidate).toEqual({ keys: [key("child")], subjects: [s(1), s(5), s(10)], repos: [] });
    expect(change.edgesAdded).toEqual([
      { ancestorId: s(1), descendantId: s(10), depth: 1, via: "split", revision: r(2) },
    ]);
    expect(change.refresh).toEqual([s(1), s(10)]);
  });

  test("a status, a link, a parent, an expand, and a keep-apart re-project nothing", () => {
    for (const decision of [
      { _tag: "Status", subject: s(1), status: "rejected" },
      { _tag: "Link", subject: s(1), repo: 7 },
      { _tag: "Parent", child: s(1), parent: s(2) },
      { _tag: "Expand", from: s(1), to: s(2), add: true },
      { _tag: "KeepApart", a: s(1), b: s(2), add: true },
    ] satisfies ReadonlyArray<Decision>) {
      expect([decision._tag, changeBetween(empty, sequence(decision)).invalidate]).toEqual([
        decision._tag,
        { keys: [], subjects: [], repos: [] },
      ]);
    }
    expect(impact(empty, sequence({ _tag: "Status", subject: s(1), status: "rejected" })).subjects).toEqual([s(1)]);
    expect(impact(empty, sequence({ _tag: "Status", subject: s(1), status: "accepted" })).subjects).toEqual([]);
  });

  test("a correction and its undo re-project that repo", () => {
    const corrected = sequence({
      _tag: "Correct",
      repo: 9,
      atom: { role: "about", value: { dim: "subject", id: s(1) } },
      present: true,
    });
    expect(changeBetween(empty, corrected).invalidate).toEqual({ keys: [], subjects: [], repos: [9] });
    expect(changeBetween(corrected, undo(corrected, 1)).invalidate).toEqual({ keys: [], subjects: [], repos: [9] });
  });
});

describe("the projection rules", () => {
  const rulesOf = (state: Pick<KnowledgeState, "canonical" | "splits" | "corrections">) => ({
    canonical: [...state.canonical].sort(),
    splits: [...state.splits]
      .map(([broad, entries]) => [broad, entries.map((entry) => [entry.revision, entry.into])])
      .sort(),
    corrections: [...state.corrections].sort(),
  });
  const kinds = new Set<string>(["Merge", "Split", "Correct", "Undo"]);
  const agree = (seed: number, steps: number) => {
    const { log } = run(seed, steps, () => {});
    const subset: ReadonlyArray<StoredDecision> = log.filter((entry) => kinds.has(entry.decision._tag));
    expect([seed, rulesOf(rules(subset))]).toEqual([seed, rulesOf(fold(log).state)]);
  };

  test("replay from merges, splits, corrections, and undos alone as the whole log folds", () => {
    for (let seed = 1; seed <= 400; seed++) agree(seed, 60);
    for (let seed = 1; seed <= 100; seed++) agree(seed, 120);
  }, 60_000);

  // A split that reuses a label an Alias removal freed, which the subset alone would refuse.
  test("keep a split whose label an Alias removal freed", () => {
    for (const seed of [396, 490, 544, 2534]) agree(seed, 60);
  });
});
