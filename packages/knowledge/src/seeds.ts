import { type Decision, extend, type KnowledgeState, type SubjectStatus } from "./decisions.ts";
import { Revision, SubjectId } from "./ids.ts";
import { type LabelKey, labelKey } from "./label-key.ts";
import { reservedKeys } from "./registry.ts";

// One concept a seed batch names: its label, definition, and other spellings, and the status it should end with. key is
// the term the seed is known by, such as a GitHub topic, when it differs from the label.
export interface SeedEntry {
  readonly key?: string;
  readonly label: string;
  readonly definition: string;
  readonly aliases: ReadonlyArray<string>;
  readonly status: SubjectStatus;
  readonly reason: string;
}

// A subject that already holds one of a seed's keys, as the database shows it.
export interface Holder {
  readonly id: SubjectId;
  readonly canonicalId: SubjectId;
  readonly label: string;
  readonly definition: string | null;
  readonly status: SubjectStatus;
  readonly repoCount: number;
}

export interface Planned {
  readonly decision: Decision;
  readonly reason: string;
}

export type SkipReason = "reserved" | "excluded" | "duplicate" | "rejected";

export interface SeedPlan {
  readonly decisions: ReadonlyArray<Planned>;
  readonly skipped: ReadonlyArray<{ readonly label: string; readonly reason: SkipReason }>;
  // Keys left out of an entry that still applied: reserved, excluded, another entry's, a rejected subject's, or one a
  // merge it needed was refused for.
  readonly droppedKeys: number;
}

// Noise: tags that say nothing about a repo. Each is a rejected subject, so its keys resolve and hide instead of
// minting, now and in every later answer.
const hacktoberfest = [
  "hacktoberfest",
  "hacktober",
  "hacktoberfest accepted",
  "hacktoberfest approved",
  ...Array.from({ length: 12 }, (_, index) => [`hacktoberfest${2014 + index}`, `hacktoberfest ${2014 + index}`]).flat(),
];
export const noise: ReadonlyArray<SeedEntry> = [
  {
    label: "Hacktoberfest",
    definition: "",
    aliases: hacktoberfest,
    status: "rejected",
    reason: "noise: an event tag, not what the repo is about",
  },
  {
    label: "open source",
    definition: "",
    aliases: ["open-source", "opensource", "oss"],
    status: "rejected",
    reason: "noise: true of every public repo",
  },
  { label: "awesome", definition: "", aliases: [], status: "rejected", reason: "noise: a list badge on its own" },
];

// A Create's subject before the database allocates it. The plan only uses it to check the batch against the fold.
const placeholder = (index: number) => SubjectId.make(Number.MAX_SAFE_INTEGER - index);

const keysOf = (entry: SeedEntry) => {
  const keys = new Map<LabelKey, string>();
  for (const text of [entry.label, ...(entry.key === undefined ? [] : [entry.key]), ...entry.aliases]) {
    const key = labelKey(text);
    if (key !== null && !keys.has(key)) keys.set(key, text);
  }
  return keys;
};

// The decisions that make the vocabulary hold each entry, skipping what it already holds, so a second run plans
// nothing. An entry no subject holds yet is a Create. Otherwise it adopts the subject that holds its own key, or the
// one most repos hold. The other holders merge into it, an accepting seed gives it its label and definition unless a
// decision already set them, its free keys become aliases, and its status moves to the seed's. A seed that accepts
// never adopts a rejected subject or overrides a curator's status, while a noise seed rejects whatever holds its keys.
// Every decision is checked against the fold, and one it refuses is left out.
export const planSeeds = (input: {
  readonly entries: ReadonlyArray<SeedEntry>;
  readonly state: KnowledgeState;
  // The default holder of each key, from knowledge_labels.
  readonly holders: ReadonlyMap<LabelKey, SubjectId>;
  // Every holder and its canonical subject.
  readonly subjects: ReadonlyMap<SubjectId, Holder>;
  // Keys an accepting seed leaves to another batch, such as the noise keys.
  readonly excluded: ReadonlySet<LabelKey>;
}): SeedPlan => {
  let state = input.state;
  const decisions: Array<Planned> = [];
  const skipped: Array<{ readonly label: string; readonly reason: SkipReason }> = [];
  const claimed = new Set<LabelKey>();
  let droppedKeys = 0;
  let created = 0;

  const add = (decision: Decision, reason: string) => {
    const makes = decision._tag === "Create" || decision._tag === "Split";
    const next = extend(state, [
      { revision: Revision.make(state.revision + 1), decision, created: makes ? placeholder(created) : null },
    ]);
    if (next._tag !== "Applied") return false;
    if (makes) created++;
    state = next.state;
    decisions.push({ decision, reason });
    return true;
  };
  const canonicalOf = (id: SubjectId) => state.canonical.get(id) ?? input.subjects.get(id)?.canonicalId ?? id;
  const info = (id: SubjectId) => input.subjects.get(id) ?? input.subjects.get(canonicalOf(id));
  const statusOf = (id: SubjectId) => state.subjects.get(id)?.status ?? info(id)?.status ?? "candidate";

  for (const entry of input.entries) {
    const all = keysOf(entry);
    const own = labelKey(entry.key ?? entry.label);
    const labelled = labelKey(entry.label);
    if (own === null || labelled === null || reservedKeys.has(own) || reservedKeys.has(labelled)) {
      skipped.push({ label: entry.label, reason: "reserved" });
      continue;
    }
    const accepting = entry.status !== "rejected";
    if (accepting && (input.excluded.has(own) || input.excluded.has(labelled))) {
      skipped.push({ label: entry.label, reason: "excluded" });
      continue;
    }
    if (claimed.has(own) || claimed.has(labelled)) {
      skipped.push({ label: entry.label, reason: "duplicate" });
      continue;
    }
    const usable = new Map<LabelKey, string>();
    for (const [key, text] of all) {
      if (reservedKeys.has(key) || claimed.has(key) || (accepting && input.excluded.has(key))) droppedKeys++;
      else usable.set(key, text);
    }
    const holderOf = (key: LabelKey) => {
      const raw = state.labels.get(key) ?? input.holders.get(key);
      return raw === undefined ? undefined : canonicalOf(raw);
    };
    const held = new Map<LabelKey, SubjectId>();
    for (const key of usable.keys()) {
      const holder = holderOf(key);
      if (holder !== undefined) held.set(key, holder);
    }
    if (
      accepting &&
      [own, labelled].some((key) => {
        const holder = held.get(key);
        return holder !== undefined && statusOf(holder) === "rejected";
      })
    ) {
      skipped.push({ label: entry.label, reason: "rejected" });
      continue;
    }
    for (const [key, holder] of held) {
      if (accepting && statusOf(holder) === "rejected") {
        held.delete(key);
        usable.delete(key);
        droppedKeys++;
      }
    }
    for (const key of usable.keys()) claimed.add(key);

    if (held.size === 0) {
      const aliases = [...usable].filter(([key]) => key !== labelled).map(([, text]) => text);
      add(
        { _tag: "Create", label: entry.label, definition: entry.definition, aliases, status: entry.status },
        entry.reason,
      );
      continue;
    }

    const holders = [...new Set(held.values())];
    const survivor =
      held.get(own) ??
      held.get(labelled) ??
      [...holders].sort((a, b) => (info(b)?.repoCount ?? 0) - (info(a)?.repoCount ?? 0) || a - b)[0];
    if (survivor === undefined) continue;
    for (const holder of holders) {
      if (holder === survivor || add({ _tag: "Merge", from: holder, into: survivor }, entry.reason)) continue;
      for (const [key, owner] of held) {
        if (owner !== holder) continue;
        usable.delete(key);
        droppedKeys++;
      }
    }
    const decided = state.subjects.get(survivor);
    const current = info(survivor);
    const free = (key: LabelKey) => {
      const holder = holderOf(key);
      return holder === undefined || holder === survivor;
    };
    const relabel = decided?.label == null && current?.label !== entry.label && free(labelled);
    const define = decided?.definition == null && entry.definition !== "" && current?.definition !== entry.definition;
    if (accepting && (relabel || define)) {
      add(
        {
          _tag: "Rename",
          subject: survivor,
          ...(relabel ? { label: entry.label } : {}),
          ...(define ? { definition: entry.definition } : {}),
        },
        entry.reason,
      );
    }
    for (const [key, text] of usable) {
      if (holderOf(key) !== undefined) continue;
      add({ _tag: "Alias", subject: survivor, label: text, add: true }, entry.reason);
    }
    const status = statusOf(survivor);
    if (status !== entry.status && (!accepting || status === "candidate")) {
      add({ _tag: "Status", subject: survivor, status: entry.status }, entry.reason);
    }
  }
  return { decisions, skipped, droppedKeys };
};
