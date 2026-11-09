import type { Atom } from "./atom.ts";
import {
  apply,
  type Decision,
  empty,
  type KnowledgeState,
  type StoredDecision,
  type SubjectStatus,
} from "./decisions.ts";
import { Revision, SelectionId, SubjectId } from "./ids.ts";

const subject = (id: number) => SubjectId.make(id);
const revision = (n: number) => Revision.make(n);

// A seeded generator, so a failing sequence replays exactly.
export const random = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const labels = ["alpha", "beta", "gamma", "Delta", "user agent", "rust", "tui", "???"];

// Random decisions over a small vocabulary: subjects 1 to 6, as if minted, and every subject a decision created.
export const generate = (
  next: () => number,
  state: KnowledgeState,
  created: ReadonlyArray<SubjectId>,
  minted: ReadonlyArray<SubjectId> = [1, 2, 3, 4, 5, 6].map(subject),
  repos: ReadonlyArray<number> = [1, 2, 3],
) => {
  const pick = <A>(values: ReadonlyArray<A>): A => values[Math.floor(next() * values.length)] as A;
  const known = [...minted, ...created];
  const someSubject = () => pick(known);
  const status = (): SubjectStatus => pick(["candidate", "accepted", "rejected"]);
  const atom = (): Atom => ({
    role: pick(["about", "alternative_to", "built_with"]),
    value: { dim: "subject", id: someSubject() },
  });
  const choices: ReadonlyArray<() => Decision> = [
    () => ({
      _tag: "Create",
      label: pick(labels),
      definition: "d",
      aliases: next() < 0.3 ? [pick(labels)] : [],
      status: status(),
    }),
    () => ({ _tag: "Merge", from: someSubject(), into: someSubject() }),
    () => ({ _tag: "Merge", from: someSubject(), into: someSubject() }),
    () => ({
      _tag: "Split",
      subject: someSubject(),
      into: { label: pick(labels), definition: "d" },
      rule: { labels: [], terms: [["browser"]], repos: [] },
    }),
    () => ({
      _tag: "Rename",
      subject: someSubject(),
      ...(next() < 0.5 ? { label: pick(labels) } : { definition: "e" }),
    }),
    () => ({ _tag: "Alias", subject: someSubject(), label: pick(labels), add: next() < 0.7 }),
    () => ({ _tag: "Parent", child: someSubject(), parent: next() < 0.8 ? someSubject() : null }),
    () => ({ _tag: "Expand", from: someSubject(), to: someSubject(), add: next() < 0.8 }),
    () => ({ _tag: "KeepApart", a: someSubject(), b: someSubject(), add: next() < 0.8 }),
    () => ({ _tag: "Status", subject: someSubject(), status: status() }),
    () => ({ _tag: "Link", subject: someSubject(), repo: next() < 0.8 ? pick(repos) : null }),
    () => ({ _tag: "Correct", repo: pick(repos.slice(0, 2)), atom: atom(), present: next() < 0.6 }),
    () => ({ _tag: "Publish", selection: SelectionId.make(1), slug: "topics/x", title: "X" }),
    () => ({
      _tag: "Undo",
      revision: state.revision === 0 ? revision(1) : revision(1 + Math.floor(next() * state.revision)),
      cascade: false,
    }),
  ];
  return pick(choices)();
};

// Applies random decisions the way decide will: each refused one leaves no row, and each accepted one is appended.
export const run = (
  seed: number,
  steps: number,
  each: (state: KnowledgeState, log: ReadonlyArray<StoredDecision>) => void,
) => {
  const next = random(seed);
  let state = empty;
  const log: Array<StoredDecision> = [];
  const created: Array<SubjectId> = [];
  for (let step = 0; step < steps; step++) {
    const decision = generate(next, state, created);
    const makes = decision._tag === "Create" || decision._tag === "Split";
    const minted = decision._tag === "Rename" && !created.includes(decision.subject);
    const stored: StoredDecision = {
      revision: revision(state.revision + 1),
      decision,
      created: makes ? subject(100 + step) : null,
      ...(minted && state.subjects.get(decision.subject)?.label == null ? { base: `minted ${decision.subject}` } : {}),
    };
    const result = apply(state, stored);
    if (result._tag !== "Applied") continue;
    if (stored.created !== null) created.push(stored.created);
    state = result.state;
    log.push(stored);
    each(state, log);
  }
  return { state, log };
};
