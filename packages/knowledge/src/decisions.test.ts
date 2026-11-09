import { describe, expect, test } from "bun:test";
import type { Atom } from "./atom.ts";
import { random, run } from "./decisions.fixture.ts";
import { apply, type Decision, empty, fold, type KnowledgeState, maxDepth, type StoredDecision } from "./decisions.ts";
import { Revision, SubjectId } from "./ids.ts";
import { reservedKeys } from "./registry.ts";

const subject = (id: number) => SubjectId.make(id);
const revision = (n: number) => Revision.make(n);

// Every derived part of the state, in a canonical order, so two states compare by value.
const snapshot = (state: KnowledgeState, withHistory = true) => {
  const sorted = <A>(values: Iterable<A>) => [...values].map((value) => JSON.stringify(value)).sort();
  return {
    ...(withHistory ? { revision: state.revision, undone: sorted(state.undone), skipped: sorted(state.skipped) } : {}),
    retired: sorted(state.retired),
    subjects: sorted(state.subjects),
    labels: sorted(state.labels),
    canonical: sorted(state.canonical),
    parents: sorted(state.parents),
    expands: sorted([...state.expands].map(([from, to]) => [from, [...to].sort()])),
    splits: sorted(state.splits),
    keepApart: sorted(state.keepApart),
    corrections: sorted(state.corrections),
  };
};

const edgesOf = (state: KnowledgeState): ReadonlyArray<readonly [SubjectId, SubjectId]> => [
  ...[...state.parents].map(([child, parent]) => [parent, child] as const),
  ...[...state.expands].flatMap(([from, to]) => [...to].map((target) => [from, target] as const)),
  ...[...state.splits].flatMap(([broad, entries]) => entries.map((entry) => [broad, entry.into] as const)),
];

const longestPath = (state: KnowledgeState) => {
  const edges = edgesOf(state);
  const from = (node: SubjectId, seen: ReadonlySet<SubjectId>): number => {
    if (seen.has(node)) return Number.POSITIVE_INFINITY;
    const next = edges.filter(([source]) => source === node).map(([, target]) => target);
    return Math.max(0, ...next.map((target) => 1 + from(target, new Set([...seen, node]))));
  };
  return Math.max(0, ...edges.map(([source]) => from(source, new Set())));
};

const expectInvariants = (state: KnowledgeState) => {
  const canonicalOf = (id: SubjectId) => state.canonical.get(id) ?? id;
  for (const [origin, survivor] of state.canonical) {
    expect(origin).not.toBe(survivor);
    expect(state.canonical.has(survivor)).toBe(false);
  }
  expect(longestPath(state)).toBeLessThanOrEqual(maxDepth);
  for (const pair of state.keepApart) {
    const [a, b] = pair.split(":").map((id) => subject(Number(id)));
    expect(canonicalOf(a as SubjectId)).not.toBe(canonicalOf(b as SubjectId));
  }
  const links = new Map<number, SubjectId>();
  for (const [id, info] of state.subjects) {
    if (info.repo === null) continue;
    const holder = links.get(info.repo);
    if (holder !== undefined) expect(canonicalOf(holder)).toBe(canonicalOf(id));
    links.set(info.repo, id);
  }
  for (const [key, id] of state.labels) {
    expect(reservedKeys.has(key)).toBe(false);
    expect(state.retired.has(id)).toBe(false);
  }
};

describe("fold and apply", () => {
  test("applying decisions one at a time equals folding the log, at every step of 200 random sequences", () => {
    const kinds = new Map<string, number>();
    for (let seed = 1; seed <= 200; seed++) {
      run(seed, 60, (state, log) => {
        const folded = fold(log);
        expect(folded.invalid).toEqual([]);
        expect(snapshot(folded.state)).toEqual(snapshot(state));
        const tag = log.at(-1)?.decision._tag ?? "none";
        kinds.set(tag, (kinds.get(tag) ?? 0) + 1);
      });
    }
    for (const tag of [
      "Create",
      "Merge",
      "Split",
      "Rename",
      "Alias",
      "Parent",
      "Expand",
      "KeepApart",
      "Status",
      "Link",
      "Correct",
      "Undo",
    ]) {
      expect([tag, (kinds.get(tag) ?? 0) >= 50]).toEqual([tag, true]);
    }
  });

  test("no reachable state has a cycle, a path past three levels, a two-hop merge, a merged keep-apart pair, or a shared link", () => {
    for (let seed = 1; seed <= 200; seed++) run(seed, 60, (state) => expectInvariants(state));
  });

  test("folding is independent of the order the log is listed in", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { log } = run(seed, 60, () => {});
      const next = random(seed + 1000);
      const shuffled = log
        .map((entry) => [next(), entry] as const)
        .sort(([a], [b]) => a - b)
        .map(([, entry]) => entry);
      expect(snapshot(fold(shuffled).state)).toEqual(snapshot(fold(log).state));
    }
  });

  test("an undo followed by its own undo restores every derived part of the state", () => {
    let restored = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const { state } = run(seed, 40, () => {});
      for (const target of state.log) {
        if (target.decision._tag === "Undo" || state.undone.has(target.revision)) continue;
        const undo = apply(state, {
          revision: revision(state.revision + 1),
          decision: { _tag: "Undo", revision: target.revision, cascade: false },
          created: null,
        });
        if (undo._tag !== "Applied") continue;
        const redo = apply(undo.state, {
          revision: revision(state.revision + 2),
          decision: { _tag: "Undo", revision: revision(state.revision + 1), cascade: false },
          created: null,
        });
        expect(redo._tag).toBe("Applied");
        if (redo._tag === "Applied") expect(snapshot(redo.state, false)).toEqual(snapshot(state, false));
        restored++;
      }
    }
    expect(restored).toBeGreaterThan(500);
  });
});

describe("apply", () => {
  const s = subject;
  const sequence = (...decisions: ReadonlyArray<Decision | readonly [Decision, number]>) => {
    let state = empty;
    for (const entry of decisions) {
      const [decision, created] = Array.isArray(entry) ? entry : [entry as Decision, null];
      const result = apply(state, {
        revision: revision(state.revision + 1),
        decision,
        created: created === null ? null : s(created),
      });
      if (result._tag !== "Applied") return result;
      state = result.state;
    }
    return { _tag: "Applied" as const, state };
  };
  const refusal = (result: ReturnType<typeof sequence>) =>
    result._tag === "Invalid" ? result.invalid.reason : result._tag;
  const create = (label: string, id: number, aliases: ReadonlyArray<string> = []) =>
    [{ _tag: "Create", label, definition: "", aliases, status: "accepted" }, id] as const;

  test("refuses each reason the state alone can prove", () => {
    expect(
      refusal(sequence({ _tag: "KeepApart", a: s(1), b: s(2), add: true }, { _tag: "Merge", from: s(1), into: s(2) })),
    ).toBe("keep-apart");
    expect(
      refusal(
        sequence(
          { _tag: "KeepApart", a: s(1), b: s(3), add: true },
          { _tag: "Merge", from: s(1), into: s(2) },
          { _tag: "Merge", from: s(3), into: s(2) },
        ),
      ),
    ).toBe("keep-apart");
    expect(refusal(sequence({ _tag: "Merge", from: s(1), into: s(1) }))).toBe("cycle");
    expect(
      refusal(
        sequence({ _tag: "Parent", child: s(2), parent: s(1) }, { _tag: "Expand", from: s(2), to: s(1), add: true }),
      ),
    ).toBe("cycle");
    expect(
      refusal(
        sequence(
          { _tag: "Parent", child: s(2), parent: s(1) },
          { _tag: "Parent", child: s(3), parent: s(2) },
          { _tag: "Parent", child: s(4), parent: s(3) },
          { _tag: "Expand", from: s(4), to: s(5), add: true },
        ),
      ),
    ).toBe("too-deep");
    expect(
      refusal(
        sequence({ _tag: "Merge", from: s(1), into: s(2) }, { _tag: "Status", subject: s(1), status: "accepted" }),
      ),
    ).toBe("not-live");
    expect(
      refusal(
        sequence(
          create("alpha", 10),
          { _tag: "Undo", revision: revision(1), cascade: false },
          { _tag: "Link", subject: s(10), repo: 1 },
        ),
      ),
    ).toBe("not-live");
    expect(refusal(sequence({ _tag: "Undo", revision: revision(5), cascade: false }))).toBe("not-live");
    expect(
      refusal(
        sequence(
          { _tag: "Link", subject: s(1), repo: 7 },
          { _tag: "Link", subject: s(2), repo: 8 },
          { _tag: "Merge", from: s(1), into: s(2) },
        ),
      ),
    ).toBe("link-conflict");
    expect(refusal(sequence({ _tag: "Link", subject: s(1), repo: 7 }, { _tag: "Link", subject: s(2), repo: 7 }))).toBe(
      "link-conflict",
    );
    expect(refusal(sequence(create("alpha", 10), create("Alpha", 11)))).toBe("label-taken");
    expect(refusal(sequence(create("alpha", 10), { _tag: "Alias", subject: s(1), label: "ALPHA", add: true }))).toBe(
      "label-taken",
    );
    for (const reserved of ["rust", "CLI", "macOS", "deprecated", "!!!"]) {
      expect([reserved, refusal(sequence(create(reserved, 10)))]).toEqual([reserved, "reserved-label"]);
    }
    expect(
      refusal(
        sequence({
          _tag: "Correct",
          repo: 1,
          atom: { role: "any", value: { dim: "subject", id: s(1) } },
          present: true,
        }),
      ),
    ).toBe("role-mismatch");
  });

  test("a link conflicts with a repo any other subject is linked to, inside the merge class too", () => {
    expect(
      refusal(
        sequence(
          { _tag: "Link", subject: s(1), repo: 7 },
          { _tag: "Merge", from: s(1), into: s(2) },
          { _tag: "Link", subject: s(2), repo: 8 },
        ),
      ),
    ).toBe("link-conflict");
    expect(
      refusal(
        sequence(
          { _tag: "Link", subject: s(1), repo: 7 },
          { _tag: "Merge", from: s(1), into: s(4) },
          { _tag: "Merge", from: s(4), into: s(3) },
          { _tag: "Link", subject: s(3), repo: 7 },
        ),
      ),
    ).toBe("link-conflict");
  });

  test("an alias removal names a key the subject holds, never another subject's", () => {
    expect(refusal(sequence(create("alpha", 10), { _tag: "Alias", subject: s(1), label: "alpha", add: false }))).toBe(
      "not-live",
    );
    const removed = sequence(create("alpha", 10, ["alef"]), {
      _tag: "Alias",
      subject: s(10),
      label: "Alef",
      add: false,
    });
    expect<unknown>(removed._tag === "Applied" && [...removed.state.labels.keys()]).toEqual(["alpha"]);
  });

  test("a correction cannot name a subject whose create was undone", () => {
    const atom: Atom = { role: "about", value: { dim: "subject", id: s(10) } };
    expect(
      refusal(
        sequence(
          create("alpha", 10),
          { _tag: "Undo", revision: revision(1), cascade: false },
          { _tag: "Correct", repo: 1, atom, present: true },
        ),
      ),
    ).toBe("not-live");
  });

  test("apply refuses a revision at or below the state's", () => {
    const first = sequence(create("alpha", 10));
    if (first._tag !== "Applied") throw new Error("the create applies");
    for (const at of [0, 1]) {
      const again = apply(first.state, {
        revision: revision(at),
        decision: { _tag: "Status", subject: s(10), status: "rejected" },
        created: null,
      });
      expect([at, again]).toEqual([at, { _tag: "Invalid", invalid: { revision: revision(at), reason: "not-live" } }]);
    }
  });

  test("keeps free the keys the registry does not reserve: tui, postgresql, chrome, ubuntu, and zlib", () => {
    const result = sequence(
      create("TUI", 10),
      create("PostgreSQL", 11),
      create("Chrome", 12),
      create("Ubuntu", 13),
      create("zlib", 14),
    );
    expect(result._tag).toBe("Applied");
    if (result._tag === "Applied")
      expect<unknown>([...result.state.labels.keys()]).toEqual(["tui", "postgresql", "chrome", "ubuntu", "zlib"]);
  });

  test("a merge maps the moving class onto the survivor in one hop", () => {
    const result = sequence({ _tag: "Merge", from: s(1), into: s(2) }, { _tag: "Merge", from: s(2), into: s(3) });
    expect<unknown>(result._tag).toBe("Applied");
    if (result._tag === "Applied")
      expect<unknown>([...result.state.canonical]).toEqual([
        [1, 3],
        [2, 3],
      ]);
  });

  test("a split stores its rule under the broad subject and gives the child its label", () => {
    const rule = { labels: [], terms: [["browser", "user-agent"]] as const, repos: [] };
    const result = sequence([
      { _tag: "Split", subject: s(1), into: { label: "User agent parsing", definition: "" }, rule },
      20,
    ]);
    expect(result._tag).toBe("Applied");
    if (result._tag !== "Applied") return;
    expect(result.state.splits.get(s(1))).toEqual([{ revision: revision(1), into: s(20), rule }]);
    expect<unknown>([...result.state.labels]).toEqual([["user agent parsing", s(20)]]);
  });

  test("a later correction of the same atom replaces the earlier one", () => {
    const atom: Atom = { role: "about", value: { dim: "subject", id: s(4) } };
    const result = sequence(
      { _tag: "Correct", repo: 9, atom, present: true },
      { _tag: "Correct", repo: 9, atom, present: false },
    );
    expect(result._tag).toBe("Applied");
    if (result._tag === "Applied") expect(result.state.corrections.get(9)).toEqual([{ atom, present: false }]);
  });

  test("an undo that would make a later decision invalid is a conflict naming it", () => {
    const result = sequence(
      create("alpha", 10),
      { _tag: "Parent", child: s(10), parent: s(1) },
      { _tag: "Undo", revision: revision(1), cascade: false },
    );
    expect(result).toEqual({ _tag: "Conflict", revisions: [revision(2)] });
  });

  test("undoing an undo redoes the decision, and an undone create retires its subject", () => {
    const undone = sequence(create("alpha", 10), { _tag: "Undo", revision: revision(1), cascade: false });
    expect(undone._tag === "Applied" && [...undone.state.retired]).toEqual([s(10)]);
    const redone = sequence(
      create("alpha", 10),
      { _tag: "Undo", revision: revision(1), cascade: false },
      { _tag: "Undo", revision: revision(2), cascade: false },
    );
    expect<unknown>(redone._tag === "Applied" && [[...redone.state.retired], [...redone.state.labels]]).toEqual([
      [],
      [["alpha", s(10)]],
    ]);
  });
});

describe("fold", () => {
  test("skips and reports a decision that is invalid against the state before it, retiring what it created", () => {
    const log: ReadonlyArray<StoredDecision> = [
      {
        revision: revision(1),
        decision: { _tag: "KeepApart", a: subject(1), b: subject(2), add: true },
        created: null,
      },
      { revision: revision(2), decision: { _tag: "Merge", from: subject(1), into: subject(2) }, created: null },
      {
        revision: revision(3),
        decision: { _tag: "Create", label: "rust", definition: "", aliases: [], status: "accepted" },
        created: subject(30),
      },
    ];
    const { state, invalid } = fold(log);
    expect(invalid).toEqual([
      { revision: revision(2), reason: "keep-apart" },
      { revision: revision(3), reason: "reserved-label" },
    ]);
    expect([...state.retired]).toEqual([subject(30)]);
    expect(state.revision).toBe(revision(3));
  });
});
