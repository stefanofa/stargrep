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
  roles,
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

// A stated group, with where each of its atoms or keys sits in the query, or null for one only the planner named. from
// says whether the query's words implied the group or the planner's guarded output named it, and relaxed whether a
// filter the words implied fell back to a boost.
interface Origin {
  readonly from: "words" | "planner";
  readonly relaxed: boolean;
}
export type Stated =
  | ({ readonly group: Db.ClosedGroup; readonly spans: ReadonlyArray<Span | null> } & Origin)
  | ({ readonly group: Db.SubjectGroup; readonly spans: ReadonlyArray<Span> } & Origin);

export interface CompiledQuery {
  readonly explicit: Selection;
  readonly stated: ReadonlyArray<Stated>;
}

export type Planned = Pick<QueryPlan.Filters, "languages" | "kinds" | "licenses">;

// What a run of words or closed values is, by the cue that introduced it. Each row gives its mode, then its mode when
// "only" narrows it, and null leaves it to full text and vectors. Promoting bare subjects to filters is a change to one
// row, gated by the recall eval.
//   negated: the target of "not", "without", or another negation, whatever it names.
//   kind and status: a word in the clause that describes the results, never a relation's target.
//   platform: a platform the results describe, or one after a cue that names no role, such as "for".
//   named: a language or platform after a cue that names its role, such as "built with" or "runs on".
//   feature: the target of "with" or "using", which names a feature as often as a dependency, as in "editor with ai".
//   cut: a relation's words that a closed word cuts short, as "local" in "for local models", where the closed word is
//   most likely the noun they describe.
type Row =
  | "negated"
  | "language"
  | "license"
  | "kind"
  | "status"
  | "platform"
  | "named"
  | "feature"
  | "relation"
  | "cut"
  | "comparison"
  | "bare";

export type Policy = Readonly<Record<Row, readonly [plain: Db.GroupMode | null, only: Db.GroupMode | null]>>;

export const policy: Policy = {
  negated: ["exclude", "exclude"],
  language: ["filter", "filter"],
  license: ["filter", "filter"],
  kind: [null, "filter"],
  status: [null, "filter"],
  platform: ["boost", "filter"],
  named: ["filter", "filter"],
  feature: ["boost", "boost"],
  relation: ["filter", "filter"],
  cut: ["boost", "filter"],
  comparison: ["boost", "boost"],
  bare: ["boost", "filter"],
};

// The policy search compiles with. The recall eval sets another one to measure a row change before it ships.
export const CurrentPolicy = Context.Reference<Policy>("@stargrep/core/search/compile/CurrentPolicy", {
  defaultValue: () => policy,
});

// A safety net for words the compiler reads wrong. When the filters a query's words imply leave fewer than below
// results, and the same search with them as boosts finds at least atLeast, search runs it that way, so those repos
// still rank first. Filters the caller or the planner named, and every exclusion, stay exact. Null turns it off.
export interface Relaxation {
  readonly below: number;
  readonly atLeast: number;
}
export const relaxation: Relaxation = { below: 3, atLeast: 6 };
export const CurrentRelaxation = Context.Reference<Relaxation | null>(
  "@stargrep/core/search/compile/CurrentRelaxation",
  { defaultValue: () => relaxation },
);

type Roles = readonly [AtomRole, ...Array<AtomRole>];

const member: Roles = ["any"];
// "with" and "using" can name a feature ("editor with vim keybindings") or a dependency ("apps using electron"), and a
// bare subject atom never reaches built_with, so they take member and with: atoms both. So does a bare negation, as in
// "without electron".
const memberOrBuilt: Roles = ["any", "built_with"];

interface Relation {
  readonly _tag: "Relation";
  // The policy row of the target's words: a relation, or a feature for "with" and "using", which only boost.
  readonly row: "relation" | "feature";
  // The roles a subject target reaches.
  readonly subjects: Roles;
  // The roles a language or platform target reaches. A cue that names them makes its target a filter.
  readonly language: Roles;
  readonly platform: Roles;
  readonly named: boolean;
}

type Cue = Relation | { readonly _tag: "Comparison" } | { readonly _tag: "Negation" } | { readonly _tag: "Only" };

const relation = (subjects: Roles, named: { readonly language?: Roles; readonly platform?: Roles } = {}): Relation => ({
  _tag: "Relation",
  row: "relation",
  subjects,
  language: named.language ?? member,
  platform: named.platform ?? member,
  named: named.language !== undefined || named.platform !== undefined,
});
const feature: Relation = { ...relation(memberOrBuilt), row: "feature" };
// Extraction rarely records what a repo is built with, so a stated dependency reaches member atoms too: "built on node"
// reaches repos that run on node, and "built with rust" repos written in Rust.
const builtWith = relation(memberOrBuilt, { language: ["written_in", "built_with"], platform: memberOrBuilt });
const comparison = { _tag: "Comparison" } as const;

const cues: ReadonlyMap<string, Cue> = new Map<string, Cue>([
  ["for", relation(member)],
  ["in", relation(member)],
  ["on", relation(member)],
  ["supports", relation(member)],
  ["integrates with", relation(member)],
  ["runs on", relation(member, { platform: ["runs_on"] })],
  ["run on", relation(member, { platform: ["runs_on"] })],
  ["running on", relation(member, { platform: ["runs_on"] })],
  ["written in", relation(member, { language: ["written_in"] })],
  ["with", feature],
  ["using", feature],
  ["built with", builtWith],
  ["built on", builtWith],
  ["built using", builtWith],
  ["made with", builtWith],
  ["powered by", builtWith],
  ...["alternative to", "alternatives to", "instead of", "replacement for", "replacements for", "replaces"].map(
    (phrase) => [phrase, comparison] as const,
  ),
  // The tokenizer reads every n't contraction, with either apostrophe, as "not". These are the forms typed without one.
  ...[
    ...["not", "never", "without", "no", "except", "excluding", "non", "cannot"],
    ...["dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent", "wont", "cant", "aint", "shant"],
    ...["shouldnt", "wouldnt", "couldnt", "hasnt", "havent", "hadnt", "mustnt", "neednt"],
    // Common typos of "doesn't" typed without an apostrophe.
    ...["dosent", "dosnt", "doesent", "dosen"],
  ].map((word) => [word, { _tag: "Negation" }] as const),
  ...["only", "just", "exclusively"].map((word) => [word, { _tag: "Only" }] as const),
]);

// Verbs and participles a negation reaches through to its target, as it reaches through a cue, so "do not support windows"
// excludes Windows, "don't work with docker" excludes Docker, and "not based on electron" excludes Electron.
const negatedVerbs = new Set([
  ...["support", "use", "need", "require", "work", "depend", "rely", "run"].flatMap((verb) => [verb, `${verb}s`]),
  ...["based", "supported", "available", "compatible", "designed", "meant", "made", "intended", "built", "dependent"],
  ...["reliant", "relying", "depending", "running", "working", "tied", "locked", "ported", "targeted", "aimed"],
  "written",
]);
// After a clause, these make it a comparison, as in "open source Slack alternative".
const comparisonMarkers = new Set(["alternative", "alternatives"]);
const stopPhrases = new Set(["open source", "opensource", "oss"]);
// Nouns every repo is. Like a kind word, one ends the words before it, so "in git repos" boosts git and "only cli tools"
// asks for CLIs alone, and it names nothing itself.
const genericNouns = new Set([
  "tool",
  "tools",
  "utility",
  "utilities",
  "project",
  "projects",
  "repo",
  "repos",
  "repository",
  "repositories",
  "software",
  "program",
  "programs",
  "thing",
  "things",
]);
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
    clauses: 4,
    policy,
    relaxation,
    cues: [...cues],
    comparisonMarkers: [...comparisonMarkers],
    stopPhrases: [...stopPhrases],
    negatedVerbs: [...negatedVerbs],
    genericNouns: [...genericNouns],
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

// The splitter mentionsFilter uses, with each word's place in the query, except that a contraction stays one word: an
// n't form such as "don't", "won’t", or "dosen't" reads as "not", and any other drops its apostrophe. A period after a
// word stays in the gap, so it ends the clause.
const tokenize = (query: string): ReadonlyArray<Token> => {
  const slashed = [...query.matchAll(/\S+/g)]
    .filter((match) => match[0].includes("/"))
    .map((match) => [match.index, match.index + match[0].length] as const);
  const tokens: Array<Token> = [];
  let previous = 0;
  for (const match of query.matchAll(/[a-z0-9+#.]+(?:['’]t\b)?/giu)) {
    const text = match[0].replace(/\.+$/, "");
    const start = match.index;
    const end = start + text.length;
    if (text !== "") {
      tokens.push({
        word: /n['’]t$/iu.test(text) ? "not" : text.replace(/['’]/gu, "").toLowerCase(),
        start,
        end,
        gap: query.slice(previous, start),
        slashed: slashed.some(([from, to]) => start >= from && end <= to),
      });
    }
    previous = end;
  }
  return tokens;
};

const joined = (gap: string) => /^[\s-]*$/.test(gap);
const breaks = (gap: string) => /[.;:!?()[\]{}"]/.test(gap);
const alternates = (gap: string) => /[,/]/.test(gap);
const isStop = (word: string) => Vocabulary.isConnective(word) || Vocabulary.isFilterWord(word) || /^[0-9]/.test(word);

type Match =
  | {
      readonly _tag: "Closed";
      readonly dim: ClosedDim;
      readonly id: string;
      readonly span: Span;
      readonly length: number;
    }
  | { readonly _tag: "Cue"; readonly cue: Cue; readonly length: number }
  | { readonly _tag: "Stop"; readonly length: number };

// The longest closed value, cue, or stop phrase that starts at a token.
const matcher =
  (tokens: ReadonlyArray<Token>, languageWords: ReadonlyMap<LabelKey, string>) =>
  (index: number): Match | null => {
    for (let length = Math.min(maxPhrase, tokens.length - index); length > 0; length--) {
      const run = tokens.slice(index, index + length);
      if (!run.every((token, n) => !token.slashed && (n === 0 || joined(token.gap)))) continue;
      const text = run.map((token) => token.word).join(" ");
      const key = labelKey(text);
      const span: Span = [run[0]?.start ?? 0, run.at(-1)?.end ?? 0];
      const language = key === null ? undefined : languageWords.get(key);
      if (language !== undefined) return { _tag: "Closed", dim: "language", id: language, span, length };
      const word = key === null ? undefined : closedWords.get(key);
      if (word !== undefined) return { _tag: "Closed", ...word, span, length };
      const cue = cues.get(text);
      if (cue !== undefined) return { _tag: "Cue", cue, length };
      if (stopPhrases.has(text)) return { _tag: "Stop", length };
    }
    return null;
  };

interface ClosedAt {
  readonly id: string;
  readonly span: Span;
}

// A run is what one cue can target: content words, split into alternatives by "or" and commas, or closed values of one
// dimension that "or" or a comma joins.
type WordRun = { readonly _tag: "Words"; readonly alternatives: Array<Array<Token>>; cut: boolean };
type ClosedRun = { readonly _tag: "Closed"; readonly dim: ClosedDim; readonly values: Array<ClosedAt> };
type NounRun = { readonly _tag: "Noun" };
type Run = WordRun | ClosedRun | NounRun;

// A clause is what one cue governs. A relation, a comparison, or a negation targets the clause's first run and nothing
// else, so the runs after it form a tail clause that describes neither the cue's target nor the results. The clause
// with no cue describes the results, and "only" narrows every run in it.
interface Clause {
  readonly cue: Relation | typeof comparison | null;
  readonly negated: boolean;
  readonly tail: boolean;
  // A tail after a negation's target, as "deno" in "without linux deno". A negation never applies a platform
  // positively, so a platform there applies nothing. A language there is one the planner read into the query, which
  // most often describes the results, as "go" in "web framework without orm go", so it keeps its mode.
  readonly afterNegation: boolean;
  exclusive: boolean;
  readonly runs: Array<Run>;
}

const clauseOf = (
  cue: Clause["cue"],
  options: {
    readonly negated?: boolean;
    readonly exclusive?: boolean;
    readonly tail?: boolean;
    readonly afterNegation?: boolean;
  } = {},
): Clause => ({
  cue,
  negated: options.negated ?? false,
  tail: options.tail ?? false,
  afterNegation: options.afterNegation ?? false,
  exclusive: options.exclusive ?? false,
  runs: [],
});

const targets = (current: Clause) => current.cue !== null || current.negated;

const parse = (tokens: ReadonlyArray<Token>, matchAt: (index: number) => Match | null): ReadonlyArray<Clause> => {
  const clauses: Array<Clause> = [clauseOf(null)];
  const current = () => clauses[clauses.length - 1] ?? clauseOf(null);
  // The run a word joins: the clause's last run when it fits, else a new run, in a tail once the clause has a target.
  const runFor = <R extends Run>(fits: (run: Run) => run is R, make: () => R): R => {
    const last = current().runs.at(-1);
    if (last !== undefined && fits(last)) return last;
    const open = current();
    if (last !== undefined && targets(open)) {
      if (last._tag === "Words") last.cut = true;
      clauses.push(clauseOf(null, { tail: true, afterNegation: open.negated || open.afterNegation }));
    }
    const run = make();
    current().runs.push(run);
    return run;
  };
  let joiner = false;
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i];
    if (token === undefined) break;
    if (token.slashed || breaks(token.gap)) {
      clauses.push(clauseOf(null));
      joiner = false;
      if (token.slashed) {
        i++;
        continue;
      }
    } else if (alternates(token.gap)) joiner = true;

    const match = matchAt(i);
    if (match === null && current().negated && current().runs.length === 0 && negatedVerbs.has(token.word)) {
      i++;
      continue;
    }
    const next = tokens[i + (match?.length ?? 1)];
    // "no-code", "non-blocking", and "no-std" are words, not negations.
    const compound = match?._tag === "Cue" && match.cue._tag === "Negation" && next?.gap === "-";
    if (match?._tag === "Closed") {
      const { dim } = match;
      const run = runFor(
        (last): last is ClosedRun => last._tag === "Closed" && last.dim === dim && joiner,
        (): ClosedRun => ({ _tag: "Closed", dim, values: [] }),
      );
      run.values.push({ id: match.id, span: match.span });
      joiner = false;
    } else if (match?._tag === "Cue" && !compound) {
      const open = current();
      const fresh = open.runs.length === 0;
      if (match.cue._tag === "Only") {
        // A leading "only" narrows the clause it opens, and a trailing one the clause it ends.
        if (fresh) open.exclusive = true;
        else {
          const owner = open.tail ? clauses.findLast((candidate) => !candidate.tail) : open;
          if (owner !== undefined) owner.exclusive = true;
          clauses.push(clauseOf(null));
        }
      } else if (match.cue._tag === "Negation") {
        clauses.push(clauseOf(null, { negated: true, exclusive: fresh && open.exclusive }));
      } else {
        // A negation reaches through a cue that follows it at once, as in "not built with".
        clauses.push(clauseOf(match.cue, { negated: fresh && open.negated, exclusive: fresh && open.exclusive }));
      }
      joiner = false;
    } else if (match?._tag !== "Stop") {
      if (token.word === "or") joiner = true;
      else if (comparisonMarkers.has(token.word)) {
        const last = current().runs.at(-1);
        if (last?._tag === "Words") {
          current().runs.pop();
          clauses.push({ ...clauseOf(comparison), runs: [last] });
        }
        clauses.push(clauseOf(null));
        joiner = false;
      } else if (genericNouns.has(token.word)) {
        runFor(
          (last): last is NounRun => last._tag === "Noun",
          (): NounRun => ({ _tag: "Noun" }),
        );
        joiner = false;
      } else if (compound || !isStop(token.word)) {
        const run = runFor(
          (last): last is WordRun => last._tag === "Words",
          (): WordRun => ({ _tag: "Words", alternatives: [[]], cut: false }),
        );
        if (joiner && (run.alternatives.at(-1)?.length ?? 0) > 0) run.alternatives.push([]);
        run.alternatives.at(-1)?.push(token);
        joiner = false;
      }
    }
    i += match?.length ?? 1;
  }
  return clauses;
};

// A role that does not accept the dimension, such as runs_on for a language, falls back to every default role.
const atomOf = (role: AtomRole, dim: ClosedDim, id: string): Atom =>
  ({ role: role === "any" || roles[role].accepts.includes(dim) ? role : "any", value: { dim, id } }) as Atom;

// The atoms a closed value reaches through each of the cue's roles, once each.
const atomsOf = (reaches: Roles, dim: ClosedDim, id: string): ReadonlyArray<Atom> => [
  ...new Map(reaches.map((role) => atomOf(role, dim, id)).map((atom) => [formatAtom(atom), atom])).values(),
];

export const compileQuery = (input: {
  readonly query: string;
  readonly planned: Planned;
  readonly explicit: Selection;
  readonly policy?: Policy;
}): CompiledQuery => {
  const { query, planned, explicit } = input;
  if (QueryPlan.queryKind(query) === "name") return { explicit, stated: [] };
  const rules = input.policy ?? policy;
  const modeOf = (row: Row, narrowed: boolean) => rules[row][narrowed ? 1 : 0];

  const plannedLanguages = [...new Set(planned.languages.flatMap((name) => idOf("language", name) ?? []))];
  const languageWords = new Map(
    languages
      .filter((value) => plannedLanguages.includes(value.id))
      .flatMap((value) => closedKeys(value).map((key) => [key, value.id] as const)),
  );
  const tokens = tokenize(query);
  const clauses = parse(tokens, matcher(tokens, languageWords));

  // Each planned language takes the role and the negation of the first clause that names it.
  const languagesAt = new Map<
    string,
    { readonly atoms: ReadonlyArray<Atom>; readonly mode: Db.GroupMode | null; readonly span: Span | null }
  >();
  // The kinds the results may have: the planner's guarded kinds, or else the last kind run that "only" narrows in the
  // clause describing the results, its head noun, so "only cli apps" asks for apps and "only apps or libraries" for
  // either.
  const plannedKinds = [...new Set(planned.kinds.flatMap((kind) => idOf("kind", kind) ?? []))];
  const lexicalKinds: Array<ClosedRun> = [];
  const words: Array<Stated> = [];
  const closedStated = (mode: Db.GroupMode, run: ClosedRun, reaches: Roles) => {
    const atoms = run.values.flatMap((value) =>
      atomsOf(reaches, run.dim, value.id).map((atom) => [atom, value.span] as const),
    );
    const [first, ...rest] = atoms;
    if (first !== undefined) {
      words.push({
        group: { _tag: "Closed", mode, any: [first[0], ...rest.map(([atom]) => atom)] },
        spans: atoms.map(([, span]) => span),
        from: "words",
        relaxed: false,
      });
    }
  };

  for (const current of clauses) {
    current.runs.forEach((run, index) => {
      if (run._tag === "Noun") return;
      const isTarget = index === 0 && targets(current);
      const cue = isTarget ? current.cue : null;
      const negated = current.negated && isTarget;
      const narrowed = current.exclusive;
      if (run._tag === "Words") {
        const filled = run.alternatives.filter((alternative) => alternative.length > 0);
        if (filled.length === 0 || filled.length > maxAlternatives) return;
        if (filled.some((alternative) => alternative.length > maxWords)) return;
        const keys = filled.map((alternative) => labelKey(alternative.map((token) => token.word).join(" ")));
        if (keys.some((key) => key === null || reservedKeys.has(key))) return;
        const row: Row =
          cue === null
            ? "bare"
            : cue._tag === "Comparison"
              ? "comparison"
              : cue.row === "feature"
                ? "feature"
                : run.cut
                  ? "cut"
                  : "relation";
        const mode = modeOf(negated ? "negated" : row, narrowed);
        if (mode === null) return;
        const reaches: Roles =
          cue?._tag === "Comparison"
            ? ["alternative_to"]
            : cue?._tag === "Relation"
              ? cue.subjects
              : negated
                ? memberOrBuilt
                : member;
        const unique = [...new Map(keys.map((key, n) => [key as LabelKey, filled[n] ?? []]))];
        const [first, ...rest] = unique;
        if (first === undefined) return;
        words.push({
          group: { _tag: "Subject", mode, roles: reaches, keys: [first[0], ...rest.map(([key]) => key)] },
          spans: unique.map(([, alternative]) => [alternative[0]?.start ?? 0, alternative.at(-1)?.end ?? 0] as const),
          from: "words",
          relaxed: false,
        });
        return;
      }
      if (run.dim === "language") {
        // A language a bare negation names is what the results are made of, as with "built with": "typescript orm, not
        // javascript" keeps a TypeScript ORM that is also for JavaScript.
        const reaches: Roles =
          cue?._tag === "Comparison"
            ? ["alternative_to"]
            : cue?._tag === "Relation"
              ? cue.language
              : negated
                ? builtWith.language
                : member;
        const row: Row = negated
          ? "negated"
          : cue?._tag === "Comparison"
            ? "comparison"
            : cue?.row === "feature"
              ? "feature"
              : "language";
        const mode = modeOf(row, narrowed);
        for (const value of run.values) {
          if (!languagesAt.has(value.id)) {
            languagesAt.set(value.id, { atoms: atomsOf(reaches, "language", value.id), mode, span: value.span });
          }
        }
        return;
      }
      if (run.dim === "kind" || run.dim === "status") {
        // A kind or status that a relation targets, or one in a tail, describes something other than the results.
        const describesResults = current.cue === null && !current.tail;
        if (!describesResults) return;
        if (negated) {
          const mode = modeOf("negated", narrowed);
          if (mode !== null) closedStated(mode, run, member);
        } else if (run.dim === "kind") {
          if (modeOf("kind", narrowed) !== null) lexicalKinds.push(run);
        } else {
          const mode = modeOf("status", narrowed);
          if (mode !== null) closedStated(mode, run, member);
        }
        return;
      }
      if (current.afterNegation) return;
      const reaches: Roles =
        cue?._tag === "Comparison" ? ["alternative_to"] : cue?._tag === "Relation" ? cue.platform : member;
      const row: Row =
        cue?._tag === "Comparison"
          ? "comparison"
          : cue?._tag !== "Relation"
            ? "platform"
            : cue.named
              ? "named"
              : cue.row === "feature"
                ? "feature"
                : "platform";
      const mode = modeOf(negated ? "negated" : row, narrowed);
      if (mode !== null) closedStated(mode, run, reaches);
    });
  }

  const plannedGroups: Array<Stated> = [];
  const closedGroup = (
    mode: Db.GroupMode,
    atoms: ReadonlyArray<readonly [Atom, Span | null]>,
    from: Origin["from"] = "planner",
  ) => {
    const [first, ...rest] = atoms;
    if (first !== undefined) {
      plannedGroups.push({
        group: { _tag: "Closed", mode, any: [first[0], ...rest.map(([atom]) => atom)] },
        spans: atoms.map(([, span]) => span),
        from,
        relaxed: false,
      });
    }
  };
  const languageAtoms = plannedLanguages.map(
    (id) =>
      languagesAt.get(id) ?? { atoms: [atomOf("any", "language", id)], mode: modeOf("language", false), span: null },
  );
  for (const mode of ["filter", "exclude", "boost"] as const) {
    closedGroup(
      mode,
      languageAtoms
        .filter((language) => language.mode === mode)
        .flatMap(({ atoms, span }) => atoms.map((atom) => [atom, span] as const)),
    );
  }
  const licenseMode = modeOf("license", false);
  if (licenseMode !== null) {
    closedGroup(
      licenseMode,
      [...new Set(planned.licenses.flatMap((name) => idOf("license", name) ?? []))].map((id) => [
        atomOf("any", "license", id),
        null,
      ]),
    );
  }
  const kindMode = modeOf("kind", true);
  if (kindMode !== null) {
    const lexical: ReadonlyArray<ClosedAt> = lexicalKinds.at(-1)?.values ?? [];
    closedGroup(
      kindMode,
      plannedKinds.length > 0
        ? plannedKinds.map((id) => [atomOf("any", "kind", id), lexical.find((value) => value.id === id)?.span ?? null])
        : lexical.map(({ id, span }) => [atomOf("any", "kind", id), span]),
      plannedKinds.length > 0 ? "planner" : "words",
    );
  }
  return { explicit, stated: [...plannedGroups, ...words].slice(0, maxGroups) };
};

const relaxable = (stated: Stated) => stated.from === "words" && stated.group.mode === "filter";

// The query with every filter its words implied as a boost, or null when its words imply no filter.
export const relaxed = (compiled: CompiledQuery): CompiledQuery | null =>
  compiled.stated.some(relaxable)
    ? {
        ...compiled,
        stated: compiled.stated.map((stated) =>
          relaxable(stated)
            ? ({ ...stated, group: { ...stated.group, mode: "boost" }, relaxed: true } as Stated)
            : stated,
        ),
      }
    : null;

export interface AppliedAtom {
  // The atom's key, such as "lang:rust" or "alt:subject:77".
  readonly atom: string;
  readonly label: string;
  readonly mode: Db.GroupMode;
  readonly from: "query" | "filter";
  readonly span: Span | null;
  // A filter the query's words implied that left almost nothing, so it boosted instead.
  readonly relaxed: boolean;
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
        relaxed: false,
      }),
    ),
  );
  const stated = compiled.stated.flatMap(({ group, spans, relaxed }, index): ReadonlyArray<AppliedAtom> => {
    if (group._tag === "Closed") {
      return group.any.map((atom, n) => ({
        atom: formatAtom(atom),
        label: closedLabel(atom) ?? "",
        mode: group.mode,
        from: "query",
        span: spans[n] ?? null,
        relaxed,
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
      relaxed,
    }));
  });
  return [...explicit, ...stated];
};
