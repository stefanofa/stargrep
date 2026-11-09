import { type Decision, extend, type KnowledgeState, type SubjectStatus } from "./decisions.ts";
import { Revision, SubjectId } from "./ids.ts";
import { type LabelKey, labelKey } from "./label-key.ts";
import { reservedKeys } from "./registry.ts";

// One concept a seed batch names, and the status it should end with. key is the term the seed is known by, such as a
// GitHub topic, when it differs from the label. The label names the concept only when it spells the key or
// reviewedLabel says someone checked that it does. aliases are other names the source lists, kept only when they spell
// the key or the label another way. synonyms are names someone reviewed, kept as they are.
export interface SeedEntry {
  readonly key?: string;
  readonly label: string;
  readonly reviewedLabel?: boolean;
  readonly definition: string;
  readonly aliases: ReadonlyArray<string>;
  readonly synonyms: ReadonlyArray<string>;
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
}

export interface Planned {
  readonly decision: Decision;
  readonly reason: string;
}

export type SkipReason = "reserved" | "excluded" | "duplicate" | "rejected";

export interface SeedPlan {
  readonly decisions: ReadonlyArray<Planned>;
  // Merges of the other subjects that hold one of an entry's names into the one it adopted. A seed never merges, so
  // these wait for a judge in the queue.
  readonly proposals: ReadonlyArray<Planned>;
  readonly skipped: ReadonlyArray<{ readonly label: string; readonly reason: SkipReason }>;
  // Names left out: not a spelling of the entry, reserved, excluded, another entry's, or held by another subject.
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
    aliases: [],
    synonyms: hacktoberfest,
    status: "rejected",
    reason: "noise: an event tag, not what the repo is about",
  },
  {
    label: "open source",
    definition: "",
    aliases: [],
    synonyms: ["open-source", "opensource", "oss"],
    status: "rejected",
    reason: "noise: true of every public repo",
  },
  {
    label: "awesome",
    definition: "",
    aliases: [],
    synonyms: [],
    status: "rejected",
    reason: "noise: a list badge on its own",
  },
];

const squash = (key: LabelKey) => key.replace(/[\s.]/g, "");
// Protocol schemes whose secure variant adds an s, which is no plural.
const secure = new Set([
  "https",
  "wss",
  "ftps",
  "sftp",
  "smtps",
  "imaps",
  "pop3s",
  "ldaps",
  "coaps",
  "mqtts",
  "amqps",
  "rtmps",
  "sips",
  "nntps",
]);
const plural = (more: string, one: string) => (more === `${one}s` || more === `${one}es`) && !secure.has(more);
const close = (a: string, b: string) => a === b || plural(a, b) || plural(b, a) || a === `${b}js` || b === `${a}js`;
// A version number at the end, as in python3 or laravel10, unless only one letter is left, since d2 is not D.
const unversioned = (word: string) => {
  const bare = word.replace(/(?<=\D)\d+$/, "");
  return bare.length >= 2 ? bare : word;
};
const initials = (key: LabelKey) =>
  key
    .split(" ")
    .map((word) => [...word][0] ?? "")
    .join("");

// Whether alias spells name another way: the same letters apart from separators and dots, a plural s or es, a js
// suffix, or a version number, or the words its initials abbreviate, as model context protocol is MCP. A source's
// other aliases often name a narrower or a neighboring concept, as 3d-printing for 3d, so they are left out.
export const spells = (alias: LabelKey, name: LabelKey): boolean => {
  const a = squash(alias);
  const b = squash(name);
  if (close(a, b) || close(unversioned(a), unversioned(b)) || (alias.includes(" ") && initials(alias) === b))
    return true;
  // A name with a gloss in parentheses, as "Remote Procedure Call (RPC)" or "X (Twitter)", spells either part. labelKey
  // trims the closing parenthesis.
  const glossed = /^(.+?) \((.+)$/.exec(alias);
  return (
    glossed?.[1] !== undefined &&
    glossed[2] !== undefined &&
    (spells(glossed[1] as LabelKey, name) || spells(glossed[2] as LabelKey, name))
  );
};

// A key's words as a label, as Argo floats for argo-floats.
const titled = (key: string) => {
  const words = key.replace(/[-_]+/g, " ").trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

// A Create's subject before the database allocates it. The plan only uses it to check the batch against the fold.
const placeholder = (index: number) => SubjectId.make(Number.MAX_SAFE_INTEGER - index);

// The decisions that make the vocabulary hold each entry, skipping what it already holds, so a second run plans
// nothing. An entry adopts the subject that holds its own key, else the one that holds its label's key, and a Create
// makes one when neither is held. A seed never merges: every other subject that holds one of the entry's names becomes
// a proposal, and that name stays with its holder. An accepting seed gives the adopted subject its definition, and its
// label when that only changes how the same name is written, unless a decision set them. Its free names become
// aliases, and its status moves to the seed's. A seed
// that accepts never adopts a rejected subject or overrides a curator's status, while a noise seed rejects whatever
// holds its keys. Every decision is checked against the fold, and one it refuses is left out.
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
  const proposals: Array<Planned> = [];
  const skipped: Array<{ readonly label: string; readonly reason: SkipReason }> = [];
  const claimed = new Set<LabelKey>();
  let droppedKeys = 0;
  let created = 0;

  const valid = (decision: Decision) =>
    extend(state, [
      {
        revision: Revision.make(state.revision + 1),
        decision,
        created: decision._tag === "Create" ? placeholder(created) : null,
      },
    ]);
  const add = (decision: Decision, reason: string) => {
    const next = valid(decision);
    if (next._tag !== "Applied") return;
    if (decision._tag === "Create") created++;
    state = next.state;
    decisions.push({ decision, reason });
  };
  // The subject a key names now, raw as the label row names it, and resolved through merges.
  const rawHolder = (key: LabelKey) => state.labels.get(key) ?? input.holders.get(key);
  const canonicalOf = (id: SubjectId) => state.canonical.get(id) ?? input.subjects.get(id)?.canonicalId ?? id;
  const holderOf = (key: LabelKey) => {
    const raw = rawHolder(key);
    return raw === undefined ? undefined : canonicalOf(raw);
  };
  const info = (id: SubjectId) => input.subjects.get(id) ?? input.subjects.get(canonicalOf(id));
  const statusOf = (id: SubjectId) => state.subjects.get(id)?.status ?? info(id)?.status ?? "candidate";

  for (const entry of input.entries) {
    const own = labelKey(entry.key ?? entry.label);
    const shown = labelKey(entry.label);
    // A source's display name often drops the disambiguator its key carries, as Argo does for argo-floats, so it names
    // the entry only when it spells the key or someone reviewed it. Otherwise the entry goes by its key's words.
    const trusted =
      own !== null && shown !== null && (shown === own || spells(shown, own) || entry.reviewedLabel === true);
    const label = trusted ? entry.label : titled(entry.key ?? entry.label);
    const labelled = trusted ? shown : own;
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
    const survivor = holderOf(own) ?? holderOf(labelled);
    if (accepting && survivor !== undefined && statusOf(survivor) === "rejected") {
      skipped.push({ label: entry.label, reason: "rejected" });
      continue;
    }

    // The entry's names in order: its label, its key, the aliases that spell one of them, and the synonyms.
    const names = new Map<LabelKey, string>();
    const name = (text: string) => {
      const key = labelKey(text);
      if (key !== null && !names.has(key)) names.set(key, text);
    };
    name(label);
    if (entry.key !== undefined) name(entry.key);
    // An alias counts only when it spells a name that is free or already the adopted subject's, so one spelling
    // family never ends up split between two subjects.
    const ours = [own, labelled].filter((base) => {
      const holder = holderOf(base);
      return holder === undefined || holder === survivor;
    });
    for (const alias of entry.aliases) {
      const key = labelKey(alias);
      if (key !== null && ours.some((base) => spells(key, base))) name(alias);
      else droppedKeys++;
    }
    for (const synonym of entry.synonyms) name(synonym);

    const free = new Map<LabelKey, string>();
    for (const [key, text] of names) {
      if (reservedKeys.has(key) || claimed.has(key) || (accepting && input.excluded.has(key))) {
        droppedKeys++;
        continue;
      }
      claimed.add(key);
      const raw = rawHolder(key);
      if (raw === undefined) {
        free.set(key, text);
        continue;
      }
      const holder = canonicalOf(raw);
      if (holder === survivor) continue;
      droppedKeys++;
      if (survivor === undefined || (accepting && statusOf(holder) === "rejected")) continue;
      const merge: Decision = { _tag: "Merge", from: holder, into: survivor };
      const known = proposals.some(
        ({ decision }) => decision._tag === "Merge" && decision.from === holder && decision.into === survivor,
      );
      if (!known && valid(merge)._tag === "Applied") {
        proposals.push({ decision: merge, reason: `${entry.reason}: "${text}" names it too` });
      }
    }

    if (survivor === undefined) {
      if (!free.has(labelled)) continue;
      const aliases = [...free].filter(([key]) => key !== labelled).map(([, text]) => text);
      add({ _tag: "Create", label, definition: entry.definition, aliases, status: entry.status }, entry.reason);
      continue;
    }

    const decided = state.subjects.get(survivor);
    const current = info(survivor);
    // A relabel only fixes how the subject's own name is written, such as its case, so it never adds a key or a
    // meaning. A source label that is just its slug, such as turn-based-strategy, reads worse than the mint.
    const relabel =
      decided?.label == null &&
      current !== undefined &&
      current.label !== label &&
      labelKey(current.label) === labelled &&
      label !== entry.key;
    const define = decided?.definition == null && entry.definition !== "" && current?.definition !== entry.definition;
    if (accepting && (relabel || define)) {
      add(
        {
          _tag: "Rename",
          subject: survivor,
          ...(relabel ? { label } : {}),
          ...(define ? { definition: entry.definition } : {}),
        },
        entry.reason,
      );
    }
    for (const [key, text] of free) {
      if (rawHolder(key) !== undefined) continue;
      add({ _tag: "Alias", subject: survivor, label: text, add: true }, entry.reason);
    }
    const status = statusOf(survivor);
    if (status !== entry.status && (!accepting || status === "candidate")) {
      add({ _tag: "Status", subject: survivor, status: entry.status }, entry.reason);
    }
  }
  return { decisions, proposals, skipped, droppedKeys };
};
