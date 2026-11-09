import type * as Db from "@stargrep/db";
import { type Atom, type AtomRole, formatAtom, type Selection } from "@stargrep/knowledge/atom";
import type { SubjectId } from "@stargrep/knowledge/ids";
import { type LabelKey, labelKey } from "@stargrep/knowledge/label-key";
import {
  type ClosedDim,
  type ClosedValue,
  closed,
  closedKeys,
  kinds,
  languages,
  platforms,
  reservedKeys,
  statuses,
} from "@stargrep/knowledge/registry";
import * as Context from "effect/Context";
import * as Hash from "effect/Hash";
import * as QueryPlan from "./query-plan.ts";
import * as Vocabulary from "./vocabulary.ts";

// Pure: no database, no model, and no vocabulary beyond the closed registry. Words become atoms only when the compiler
// is sure. A subject clause applies only when SQL finds that every key names exactly one accepted subject, and words
// that compile to nothing stay with full text and vectors, which see every word either way.

export type Span = readonly [start: number, end: number];

// A stated group, with where each of its atoms or keys sits in the query, or null for one only the planner named.
export type Stated =
  | { readonly group: Db.ClosedGroup; readonly spans: ReadonlyArray<Span | null> }
  | { readonly group: Db.SubjectGroup; readonly spans: ReadonlyArray<Span> };

export interface CompiledQuery {
  readonly explicit: Selection;
  readonly stated: ReadonlyArray<Stated>;
}

export type Planned = Pick<QueryPlan.Filters, "languages" | "kinds" | "licenses">;

// What a clause is, by the word that introduced it. Each row gives its mode outside strict mode and in it, and null
// leaves the clause to full text and vectors. Promoting bare subjects to filters is a change to one row, gated by the
// recall eval. A relation clause that a closed word cuts short, as "local" in "for local models", is cut: the closed
// word is most likely the noun the clause describes.
type Clause = "language" | "license" | "kind" | "status" | "platform" | "relation" | "cut" | "comparison" | "bare";

export type Policy = Readonly<Record<Clause, readonly [loose: Db.GroupMode | null, strict: Db.GroupMode | null]>>;

export const policy: Policy = {
  language: ["filter", "filter"],
  license: ["filter", "filter"],
  kind: [null, "filter"],
  status: [null, "filter"],
  platform: ["boost", "filter"],
  relation: ["filter", "filter"],
  cut: ["boost", "filter"],
  comparison: ["boost", "boost"],
  bare: ["boost", "filter"],
};

// The policy search compiles with. The recall eval sets another one to measure a row change before it ships.
export const CurrentPolicy = Context.Reference<Policy>("@stargrep/core/search/compile/CurrentPolicy", {
  defaultValue: () => policy,
});

const member: Roles = ["any"];
// A bare subject atom never reaches built_with, so words that may mean "built with" also take with: atoms.
const memberOrBuilt: Roles = ["any", "built_with"];
type Roles = readonly [AtomRole, ...Array<AtomRole>];

type Cue =
  | { readonly _tag: "Relation"; readonly roles: Roles }
  | { readonly _tag: "Comparison" }
  | { readonly _tag: "Negation" };

const relation = (roles: Roles): Cue => ({ _tag: "Relation", roles });
const comparison: Cue = { _tag: "Comparison" };
const negation: Cue = { _tag: "Negation" };

const cues: ReadonlyMap<string, Cue> = new Map([
  ["for", relation(member)],
  ["in", relation(member)],
  ["on", relation(member)],
  ["runs on", relation(member)],
  ["written in", relation(member)],
  ["supports", relation(member)],
  ["integrates with", relation(member)],
  ["with", relation(memberOrBuilt)],
  ["using", relation(memberOrBuilt)],
  ["built with", relation(memberOrBuilt)],
  ["built on", relation(memberOrBuilt)],
  ["built using", relation(memberOrBuilt)],
  ["made with", relation(memberOrBuilt)],
  ["alternative to", comparison],
  ["alternatives to", comparison],
  ["instead of", comparison],
  ["replacement for", comparison],
  ["replacements for", comparison],
  ["replaces", comparison],
  ["not", negation],
  ["without", negation],
  ["no", negation],
  ["except", negation],
  ["excluding", negation],
  ["non", negation],
]);

// After a clause, these make it a comparison, as in "open source Slack alternative".
const comparisonMarkers = new Set(["alternative", "alternatives"]);
const stopPhrases = new Set(["open source", "opensource", "oss"]);
const maxPhrase = 4;
const maxGroups = 8;
const maxAlternatives = 4;
const maxWords = 4;

const closedEntries = (dim: ClosedDim, values: ReadonlyArray<ClosedValue<string>>) =>
  values.flatMap((value) => closedKeys(value).map((key) => [key, { dim, id: value.id }] as const));

// The closed words a query may state. Languages and licenses enter only from the planner's guarded output, so a
// language word the planner did not report stays an ordinary word.
const closedWords: ReadonlyMap<LabelKey, { readonly dim: ClosedDim; readonly id: string }> = new Map([
  ...closedEntries("kind", kinds),
  ...closedEntries("platform", platforms),
  ...closedEntries("status", statuses),
]);

const idOf = (dim: ClosedDim, name: string): string | undefined => {
  const key = labelKey(name);
  return closed[dim].find(
    (value) => value.id.toLowerCase() === name.toLowerCase() || closedKeys(value).some((k) => k === key),
  )?.id;
};

export const version = Hash.string(
  JSON.stringify({
    policy,
    cues: [...cues],
    comparisonMarkers: [...comparisonMarkers],
    stopPhrases: [...stopPhrases],
    closedWords: [...closedWords],
    bounds: [maxPhrase, maxGroups, maxAlternatives, maxWords],
  }),
);

interface Token {
  readonly word: string;
  readonly start: number;
  readonly end: number;
  // The text since the previous token: whitespace, or punctuation that separates alternatives or ends a clause.
  readonly gap: string;
  // Part of a word with a slash, such as owner/name, which is never a facet.
  readonly slashed: boolean;
}

// The splitter mentionsFilter uses, with each word's place in the query.
const tokenize = (query: string): ReadonlyArray<Token> => {
  const slashed = [...query.matchAll(/\S+/g)]
    .filter((match) => match[0].includes("/"))
    .map((match) => [match.index, match.index + match[0].length] as const);
  const tokens: Array<Token> = [];
  let previous = 0;
  for (const match of query.matchAll(/[a-z0-9+#.]+/gi)) {
    const word = match[0].replace(/\.+$/, "");
    const start = match.index;
    const end = start + word.length;
    if (word !== "") {
      tokens.push({
        word: word.toLowerCase(),
        start,
        end,
        gap: query.slice(previous, start),
        slashed: slashed.some(([from, to]) => start >= from && end <= to),
      });
    }
    previous = start + match[0].length;
  }
  return tokens;
};

const joined = (gap: string) => /^[\s-]*$/.test(gap);
const breaks = (gap: string) => /[.;:!?()[\]{}"]/.test(gap);
const alternates = (gap: string) => /[,/]/.test(gap);
const isStop = (word: string) => Vocabulary.isConnective(word) || Vocabulary.isFilterWord(word) || /^[0-9]/.test(word);

interface ClauseContext {
  readonly cue: Cue | null;
  readonly negated: boolean;
}

const none: ClauseContext = { cue: null, negated: false };

export const compileQuery = (input: {
  readonly query: string;
  readonly planned: Planned;
  readonly explicit: Selection;
  readonly policy?: Policy;
}): CompiledQuery => {
  const { query, planned, explicit } = input;
  if (QueryPlan.queryKind(query) === "name") return { explicit, stated: [] };
  const strict = Vocabulary.restrictsKind(query);
  const rules = input.policy ?? policy;
  const modeOf = (clause: Clause) => rules[clause][strict ? 1 : 0];

  const plannedLanguages = [...new Set(planned.languages.flatMap((name) => idOf("language", name) ?? []))];
  const languageWords = new Map(
    languages
      .filter((value) => plannedLanguages.includes(value.id))
      .flatMap((value) => closedKeys(value).map((key) => [key, value.id] as const)),
  );
  const languageSpans = new Map<string, Span>();
  const kindWords = new Map<string, Span | null>(
    planned.kinds.flatMap((kind) => {
      const id = idOf("kind", kind);
      return id === undefined ? [] : [[id, null] as const];
    }),
  );

  const words: Array<Stated> = [];
  const tokens = tokenize(query);
  let context = none;
  // A closed word ends its clause. The cue it followed still reaches closed words joined to it by "or" or a comma, and
  // nothing else.
  let afterClosed = false;
  let joinedByOr = false;
  let alternatives: Array<Array<Token>> = [[]];
  // The last closed group, while only "or" and separators follow it, so "macos or linux" is one group.
  let open: { readonly dim: ClosedDim; readonly stated: Stated & { readonly group: Db.ClosedGroup } } | null = null;

  // Ends the clause, and says whether it had words.
  const flush = (ending: { readonly asComparison?: boolean; readonly byClosedWord?: boolean } = {}): boolean => {
    const filled = alternatives.filter((words) => words.length > 0);
    alternatives = [[]];
    if (filled.length === 0) return false;
    open = null;
    if (filled.length > maxAlternatives || filled.some((words) => words.length > maxWords)) return true;
    const keys = filled.map((words) => labelKey(words.map((token) => token.word).join(" ")));
    if (keys.some((key) => key === null || reservedKeys.has(key))) return true;
    const cue: Cue | null = ending.asComparison === true ? comparison : context.cue;
    const mode = context.negated
      ? "exclude"
      : modeOf(
          cue === null
            ? "bare"
            : cue._tag === "Comparison"
              ? "comparison"
              : ending.byClosedWord === true
                ? "cut"
                : "relation",
        );
    if (mode === null) return true;
    const roles: Roles =
      cue?._tag === "Comparison"
        ? ["alternative_to"]
        : cue?._tag === "Relation"
          ? cue.roles
          : context.negated
            ? memberOrBuilt
            : member;
    const unique = [...new Map(keys.map((key, index) => [key as LabelKey, filled[index] ?? []]))];
    const [first, ...rest] = unique;
    if (first === undefined) return true;
    words.push({
      group: { _tag: "Subject", mode, roles, keys: [first[0], ...rest.map(([key]) => key)] },
      spans: unique.map(([, words]) => [words[0]?.start ?? 0, words.at(-1)?.end ?? 0] as const),
    });
    return true;
  };

  const closedAtom = (dim: ClosedDim, id: string, span: Span) => {
    if (dim === "language") {
      languageSpans.set(id, span);
      return;
    }
    if (dim === "kind" && !context.negated) {
      if (modeOf("kind") !== null && (kindWords.get(id) ?? null) === null) kindWords.set(id, span);
      return;
    }
    const role: AtomRole = context.cue?._tag === "Comparison" && dim === "platform" ? "alternative_to" : "any";
    const mode = context.negated
      ? "exclude"
      : role === "alternative_to"
        ? modeOf("comparison")
        : modeOf(dim === "platform" ? "platform" : "status");
    if (mode === null || (context.cue?._tag === "Comparison" && role !== "alternative_to")) return;
    const atom = { role, value: { dim, id } } as Atom;
    if (open !== null && open.dim === dim && open.stated.group.mode === mode) {
      const group = open.stated.group;
      const stated = { group: { ...group, any: [...group.any, atom] as const }, spans: [...open.stated.spans, span] };
      words[words.indexOf(open.stated)] = stated;
      open = { dim, stated };
      return;
    }
    const stated = { group: { _tag: "Closed", mode, any: [atom] } as Db.ClosedGroup, spans: [span] };
    words.push(stated);
    open = { dim, stated };
  };

  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i];
    if (token === undefined) break;
    if (token.slashed || breaks(token.gap)) {
      flush();
      context = none;
      open = null;
      if (token.slashed) {
        i++;
        continue;
      }
    } else if (alternates(token.gap)) alternatives.push([]);

    const phrases = [...Array(Math.min(maxPhrase, tokens.length - i)).keys()]
      .map((n) => tokens.slice(i, i + n + 1))
      .filter((run) => run.every((t, index) => !t.slashed && (index === 0 || joined(t.gap))))
      .reverse();
    const match = phrases
      .map((run) => {
        const text = run.map((t) => t.word).join(" ");
        const key = labelKey(text);
        const span: Span = [run[0]?.start ?? 0, run.at(-1)?.end ?? 0];
        const language = key === null ? undefined : languageWords.get(key);
        if (language !== undefined)
          return { length: run.length, closed: { dim: "language" as const, id: language }, span };
        const word = key === null ? undefined : closedWords.get(key);
        if (word !== undefined) return { length: run.length, closed: word, span };
        const cue = cues.get(text);
        if (cue !== undefined) return { length: run.length, cue, span };
        if (stopPhrases.has(text)) return { length: run.length, span };
        return null;
      })
      .find((found) => found !== null);

    if (afterClosed) {
      if (token.word === "or") joinedByOr = true;
      else if (match?.closed === undefined || !(joinedByOr || alternates(token.gap))) {
        context = none;
        afterClosed = false;
        joinedByOr = false;
      }
      if (match?.closed !== undefined) joinedByOr = false;
    }
    if (match?.closed !== undefined) {
      flush({ byClosedWord: true });
      closedAtom(match.closed.dim, match.closed.id, match.span);
      afterClosed = true;
    } else if (match?.cue !== undefined) {
      // A negation reaches through a cue that follows it at once, as in "not built with".
      const ended = flush();
      open = null;
      context =
        match.cue._tag === "Negation"
          ? { cue: null, negated: true }
          : { cue: match.cue, negated: context.negated && context.cue === null && !ended };
    } else if (match === undefined || match === null) {
      if (token.word === "or") alternatives.push([]);
      else if (comparisonMarkers.has(token.word)) {
        flush({ asComparison: true });
        context = none;
      } else if (!isStop(token.word)) {
        open = null;
        alternatives[alternatives.length - 1]?.push(token);
      }
    }
    i += match?.length ?? 1;
  }
  flush();

  const plannedGroups: Array<Stated> = [];
  const closedGroup = (mode: Db.GroupMode, atoms: ReadonlyArray<readonly [Atom, Span | null]>) => {
    const [first, ...rest] = atoms;
    if (first !== undefined) {
      plannedGroups.push({
        group: { _tag: "Closed", mode, any: [first[0], ...rest.map(([atom]) => atom)] },
        spans: atoms.map(([, span]) => span),
      });
    }
  };
  const languageMode = modeOf("language");
  if (languageMode !== null) {
    closedGroup(
      languageMode,
      plannedLanguages.map((id) => [
        { role: "any", value: { dim: "language", id } } as Atom,
        languageSpans.get(id) ?? null,
      ]),
    );
  }
  const licenseMode = modeOf("license");
  if (licenseMode !== null) {
    closedGroup(
      licenseMode,
      [...new Set(planned.licenses.flatMap((name) => idOf("license", name) ?? []))].map((id) => [
        { role: "any", value: { dim: "license", id } } as Atom,
        null,
      ]),
    );
  }
  const kindMode = modeOf("kind");
  if (kindMode !== null) {
    closedGroup(
      kindMode,
      [...kindWords].map(([id, span]) => [{ role: "any", value: { dim: "kind", id } } as Atom, span]),
    );
  }
  return { explicit, stated: [...plannedGroups, ...words].slice(0, maxGroups) };
};

export interface AppliedAtom {
  // The atom's key, such as "lang:rust" or "alt:subject:77".
  readonly atom: string;
  readonly label: string;
  readonly mode: Db.GroupMode;
  readonly from: "query" | "filter";
  readonly span: Span | null;
}

const closedLabel = (atom: Atom) =>
  atom.value.dim === "subject"
    ? null
    : (closed[atom.value.dim].find((value) => value.id === atom.value.id)?.label ?? null);

// The atoms the search applied, as SQL resolved them: every explicit atom, every closed group, and every subject group
// whose keys all named a subject. A group that did not resolve applied nothing, so it is left out.
export const applied = (compiled: CompiledQuery, resolution: Db.Resolution): ReadonlyArray<AppliedAtom> => {
  const labelOf = (id: SubjectId) => resolution.labels[String(id)] ?? String(id);
  const explicit = compiled.explicit.all.flatMap((group) =>
    group.any.map(
      (atom): AppliedAtom => ({
        atom: formatAtom(atom),
        label: closedLabel(atom) ?? (atom.value.dim === "subject" ? labelOf(atom.value.id) : ""),
        mode: group.negate ? "exclude" : "filter",
        from: "filter",
        span: null,
      }),
    ),
  );
  const stated = compiled.stated.flatMap(({ group, spans }, index): ReadonlyArray<AppliedAtom> => {
    if (group._tag === "Closed") {
      return group.any.map((atom, n) => ({
        atom: formatAtom(atom),
        label: closedLabel(atom) ?? "",
        mode: group.mode,
        from: "query",
        span: spans[n] ?? null,
      }));
    }
    const ids = resolution.stated[index];
    if (ids === null || ids === undefined) return [];
    return ids.map((id, n) => ({
      atom: formatAtom({ role: group.roles[0], value: { dim: "subject", id } }),
      label: labelOf(id),
      mode: group.mode,
      from: "query",
      span: spans[n] ?? null,
    }));
  });
  return [...explicit, ...stated];
};
