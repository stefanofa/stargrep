import { type FacetRef, formatAtom } from "./atom.ts";
import type { Claim } from "./claims.ts";
import { type KnowledgeState, maxDepth, type SplitEntry } from "./decisions.ts";
import { evidenceText } from "./evidence-text.ts";
import type { SubjectId } from "./ids.ts";
import { type LabelKey, labelKey } from "./label-key.ts";
import {
  type ClosedDim,
  type ClosedValue,
  closed,
  closedKeys,
  type Dim,
  type KindId,
  licenses,
  type RoleId,
  reservedKeys,
  roleIds,
  roles,
} from "./registry.ts";

export interface RepoIdentity {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
}

// GitHub facts, read from the repos row. They are claims too: the primary language is written_in, the license is
// licensed, a language topic is for, a platform topic is runs_on, and a topic whose key has a label is tagged. A topic
// never mints, never sets a kind or status, and never resolves an impliedBy name.
export interface RepoFacts {
  readonly language: string | null;
  readonly license: string | null;
  readonly topics: ReadonlyArray<string>;
}

export interface LabelEntry {
  readonly subject: SubjectId;
  readonly isDefault: boolean;
}

// The label entries of every key the repo looks up, from knowledge_labels, where a decision default outranks a minted
// one.
export type LabelIndex = ReadonlyMap<LabelKey, ReadonlyArray<LabelEntry>>;

export type Rules = Pick<KnowledgeState, "canonical" | "splits" | "corrections">;

export interface ProjectionInput {
  readonly repo: RepoIdentity;
  readonly facts: RepoFacts;
  // The current receipt's claims, empty for a repo with no receipt.
  readonly claims: ReadonlyArray<Claim>;
  readonly labels: LabelIndex;
  readonly rules: Rules;
}

export interface ProjectedAtom {
  readonly role: RoleId;
  readonly value: FacetRef;
}

export type VerdictReason =
  | "closed-value"
  | "implied"
  | "label"
  | "split-rule"
  | "ambiguous-default"
  | "minted"
  | "corrected-in"
  | "corrected-out"
  | "reserved-label"
  | "unresolved-closed"
  | "quote-required"
  | "self-comparison"
  | "over-limit"
  | "topic-unknown"
  | "license-unknown";

export type VerdictSource =
  | { readonly from: "receipt"; readonly ordinal: number }
  | { readonly from: "facts"; readonly field: "language" | "license" | "topic"; readonly index: number }
  | { readonly from: "correction"; readonly index: number };

// Why each claim was used or dropped, kept on the receipt so curation can list them without projecting again.
export interface ClaimVerdict {
  readonly claim: VerdictSource;
  readonly outcome: "used" | "dropped" | "mint";
  readonly reason: VerdictReason;
  readonly atom: string | null;
}

// A key a claim in a minting role needs. The new subject starts with the claim's surface form as its label.
export interface MintRequest {
  readonly key: LabelKey;
  readonly label: string;
}

export interface Projection {
  // Every role's atoms, in registry role order, distinct, and sorted, except kinds, which keep the primary kind first.
  readonly atoms: ReadonlyArray<ProjectedAtom>;
  // Keys looked up and not found, so a later label for one marks the repo stale. Reserved keys never get a label.
  readonly unresolvedKeys: ReadonlyArray<LabelKey>;
  readonly verdicts: ReadonlyArray<ClaimVerdict>;
  // Non-empty means the atoms are incomplete: mint these, then project again.
  readonly mints: ReadonlyArray<MintRequest>;
}

const indexBy = (dim: ClosedDim, names: (entry: ClosedValue<string>) => ReadonlyArray<LabelKey>) =>
  new Map(closed[dim].flatMap((entry) => names(entry).map((key) => [key, { dim, id: entry.id } as FacetRef] as const)));

const closedDims = ["kind", "language", "platform", "status"] as const satisfies ReadonlyArray<ClosedDim>;
type SpelledDim = (typeof closedDims)[number];

const byDim = (names: (entry: ClosedValue<string>) => ReadonlyArray<LabelKey>) => ({
  kind: indexBy("kind", names),
  language: indexBy("language", names),
  platform: indexBy("platform", names),
  status: indexBy("status", names),
});
const spellings: Record<SpelledDim, ReadonlyMap<LabelKey, FacetRef>> = byDim(closedKeys);
const implications: Record<SpelledDim, ReadonlyMap<LabelKey, FacetRef>> = byDim((entry) =>
  entry.impliedBy.flatMap((name) => labelKey(name) ?? []),
);

const isSpelled = (dim: Dim): dim is SpelledDim => (closedDims as ReadonlyArray<Dim>).includes(dim);

// A claim's closed value, trying the role's closed dimensions in order. impliedBy names count only in a role that
// accepts nothing but that dimension, so Chrome is the browser in runs_on and stays a subject in for.
const resolveClosed = (
  role: RoleId,
  key: LabelKey,
): { readonly value: FacetRef; readonly reason: VerdictReason } | null => {
  const accepts = roles[role].accepts;
  for (const dim of accepts) {
    if (!isSpelled(dim)) continue;
    const spelled = spellings[dim].get(key);
    if (spelled !== undefined) return { value: spelled, reason: "closed-value" };
    const implied = accepts.length === 1 ? implications[dim].get(key) : undefined;
    if (implied !== undefined) return { value: implied, reason: "implied" };
  }
  return null;
};

// A role a bare atom does not reach relates the repo to another project: built with it, an alternative to it, or
// replaced by it. None of those holds between a project and itself.
export const namesAnotherProject = (role: RoleId) => roles[role].matches !== "bare";

const ownKeys = (repo: RepoIdentity) =>
  new Set([labelKey(repo.name), labelKey(`${repo.owner}/${repo.name}`)].flatMap((key) => key ?? []));

// A list or a course covers what it names rather than working with it, so on a repo whose primary kind is one of
// these, a for claim projects as about.
const coveringKinds: ReadonlySet<string> = new Set(["list", "learning"] satisfies ReadonlyArray<KindId>);

// Every key project() looks up in the label index, so the caller can load exactly those.
export const lookupKeys = (claims: ReadonlyArray<Claim>, facts: RepoFacts): ReadonlyArray<LabelKey> => [
  ...new Set([...claims.map((claim) => claim.key), ...facts.topics.flatMap((topic) => labelKey(topic) ?? [])]),
];

interface Evidence {
  readonly key: LabelKey;
  readonly term: string;
  readonly quote: string | null;
}

const ruleMatches = ({ rule }: SplitEntry, evidence: Evidence, repo: number) => {
  const text = evidenceText(`${evidence.quote ?? ""} ${evidence.term}`);
  const occurs = (word: string) => {
    const needle = evidenceText(word);
    return needle.length > 0 && text.includes(needle);
  };
  return (
    rule.labels.includes(evidence.key) || rule.terms.some((words) => words.every(occurs)) || rule.repos.includes(repo)
  );
};

// The split rules of the subject a key resolved to and of its canonical survivor, in revision order. The first match
// moves the claim to that child, whose own rules apply next, as deep as the closure goes.
const splitTarget = (subject: SubjectId, evidence: Evidence, repo: number, rules: Rules): SubjectId => {
  let current = subject;
  for (let depth = 0; depth < maxDepth; depth++) {
    const survivor = rules.canonical.get(current);
    const entries = [current, ...(survivor === undefined ? [] : [survivor])]
      .flatMap((id) => rules.splits.get(id) ?? [])
      .sort((a, b) => a.revision - b.revision);
    const hit = entries.find((entry) => ruleMatches(entry, evidence, repo));
    if (hit === undefined) return current;
    current = hit.into;
  }
  return current;
};

const order = (a: string | number, b: string | number) =>
  typeof a === "number" && typeof b === "number" ? a - b : a < b ? -1 : a > b ? 1 : 0;
const compareAtoms = (a: ProjectedAtom, b: ProjectedAtom) =>
  order(a.value.dim, b.value.dim) || order(a.value.id, b.value.id);

const projectWith = (input: ProjectionInput, forClaimsAs: "for" | "about"): Projection => {
  const own = ownKeys(input.repo);
  const verdicts: Array<ClaimVerdict> = [];
  const unresolved = new Set<LabelKey>();
  const mints = new Map<LabelKey, string>();
  const kept = new Map<RoleId, Array<ProjectedAtom>>();
  // Keys a role waits on a mint for. Each holds a slot as a kept atom does, so a claim past the role's max never
  // mints, and the projection after the mint keeps the same claims as the one before it.
  const pending = new Map<RoleId, Set<LabelKey>>();
  const full = (role: RoleId) => (kept.get(role)?.length ?? 0) + (pending.get(role)?.size ?? 0) >= roles[role].max;

  const record = (claim: VerdictSource, outcome: ClaimVerdict["outcome"], reason: VerdictReason, atom: string | null) =>
    verdicts.push({ claim, outcome, reason, atom });

  const keep = (claim: VerdictSource, role: RoleId, value: FacetRef, reason: VerdictReason) => {
    const atom = { role, value };
    const key = formatAtom(atom);
    const list = kept.get(role) ?? [];
    if (list.some((other) => formatAtom(other) === key)) return record(claim, "used", reason, key);
    if (full(role)) return record(claim, "dropped", "over-limit", key);
    kept.set(role, [...list, atom]);
    record(claim, "used", reason, key);
  };

  const resolveSubject = (claim: VerdictSource, role: RoleId, evidence: Evidence) => {
    if (reservedKeys.has(evidence.key)) return record(claim, "dropped", "reserved-label", null);
    const entries = input.labels.get(evidence.key) ?? [];
    const chosen = entries.find((entry) => entry.isDefault) ?? entries[0];
    if (chosen === undefined) {
      unresolved.add(evidence.key);
      if (!roles[role].mints) return record(claim, "dropped", "topic-unknown", null);
      const waiting = pending.get(role) ?? new Set<LabelKey>();
      if (!waiting.has(evidence.key) && full(role)) return record(claim, "dropped", "over-limit", null);
      pending.set(role, waiting.add(evidence.key));
      if (!mints.has(evidence.key)) mints.set(evidence.key, evidence.term);
      return record(claim, "mint", "minted", null);
    }
    const subject = splitTarget(chosen.subject, evidence, input.repo.id, input.rules);
    const reason = subject !== chosen.subject ? "split-rule" : entries.length > 1 ? "ambiguous-default" : "label";
    keep(claim, role, { dim: "subject", id: subject }, reason);
  };

  for (const claim of [...input.claims].sort((a, b) => a.ordinal - b.ordinal)) {
    const source = { from: "receipt", ordinal: claim.ordinal } as const;
    const role = claim.role === "for" ? forClaimsAs : claim.role;
    const spec = roles[role];
    if (spec.quoteRequired && claim.found !== "quote") {
      record(source, "dropped", "quote-required", null);
      continue;
    }
    if (namesAnotherProject(role) && own.has(claim.key)) {
      record(source, "dropped", "self-comparison", null);
      continue;
    }
    const resolved = resolveClosed(role, claim.key);
    if (resolved !== null) keep(source, role, resolved.value, resolved.reason);
    else if (!spec.accepts.includes("subject")) record(source, "dropped", "unresolved-closed", null);
    else resolveSubject(source, role, claim);
  }

  const { language, license, topics } = input.facts;
  if (language !== null) {
    const key = labelKey(language);
    const value = key === null ? undefined : spellings.language.get(key);
    const source = { from: "facts", field: "language", index: 0 } as const;
    if (value === undefined) record(source, "dropped", "unresolved-closed", null);
    else keep(source, "written_in", value, "closed-value");
  }
  if (license !== null) {
    const source = { from: "facts", field: "license", index: 0 } as const;
    const value = licenses.find((entry) => entry.id === license);
    if (value === undefined) record(source, "dropped", "license-unknown", null);
    else keep(source, "licensed", { dim: "license", id: value.id }, "closed-value");
  }
  for (const [index, topic] of topics.entries()) {
    const source = { from: "facts", field: "topic", index } as const;
    const key = labelKey(topic);
    if (key === null) {
      record(source, "dropped", "topic-unknown", null);
      continue;
    }
    const languageValue = spellings.language.get(key);
    const platformValue = spellings.platform.get(key);
    if (languageValue !== undefined) keep(source, "for", languageValue, "closed-value");
    else if (platformValue !== undefined) keep(source, "runs_on", platformValue, "closed-value");
    else resolveSubject(source, "tagged", { key, term: topic, quote: null });
  }

  // A curator's present atom goes first in its role so the role's max never drops it, and an absent one leaves.
  const removed = new Map<string, VerdictReason>();
  for (const [index, correction] of (input.rules.corrections.get(input.repo.id) ?? []).entries()) {
    const { role, value } = correction.atom;
    if (role === "any") continue;
    const atom = { role, value };
    const key = formatAtom(atom);
    const others = (kept.get(role) ?? []).filter((other) => formatAtom(other) !== key);
    const source = { from: "correction", index } as const;
    if (!correction.present) {
      kept.set(role, others);
      removed.set(key, "corrected-out");
      record(source, "dropped", "corrected-out", key);
      continue;
    }
    const list = [atom, ...others];
    for (const pushed of list.slice(roles[role].max)) removed.set(formatAtom(pushed), "over-limit");
    kept.set(role, list.slice(0, roles[role].max));
    removed.delete(key);
    record(source, "used", "corrected-in", key);
  }

  const atoms = roleIds.flatMap((role) => {
    const list = kept.get(role) ?? [];
    return role === "is" ? list : [...list].sort(compareAtoms);
  });
  const final = new Set(atoms.map((atom) => formatAtom(atom)));
  return {
    atoms,
    unresolvedKeys: [...unresolved].sort(),
    verdicts: verdicts.map((verdict) =>
      verdict.outcome === "used" &&
      verdict.claim.from !== "correction" &&
      verdict.atom !== null &&
      !final.has(verdict.atom)
        ? { ...verdict, outcome: "dropped", reason: removed.get(verdict.atom) ?? "over-limit" }
        : verdict,
    ),
    mints: [...mints].map(([key, label]) => ({ key, label })),
  };
};

// One repo's atoms from its receipt's claims, its GitHub facts, the label index, and the curated rules. It reads no
// clock, database, or model, so the same inputs always give the same atoms. Claims come first, in the model's order,
// then the facts, and each role keeps at most its max distinct atoms. Corrections apply last and win. A repo whose
// primary kind turns out to cover what it names projects again with its for claims as about. Kinds never depend on
// for claims, so the second pass keeps the same primary kind.
export const project = (input: ProjectionInput): Projection => {
  const projection = projectWith(input, "for");
  const primary = projection.atoms[0]?.value;
  return primary?.dim === "kind" && coveringKinds.has(primary.id) ? projectWith(input, "about") : projection;
};
