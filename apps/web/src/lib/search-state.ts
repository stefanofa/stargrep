import type { PipPose, Result, ResultGroup, StatusIcon } from "@stargrep/ui";
import type { EnrichmentProgress, LibraryRepo, SyncStatus } from "./rpc.ts";

const count = new Intl.NumberFormat("en");
const n = (value: number) => count.format(value);
const stars = (value: number) => `${n(value)} ${value === 1 ? "star" : "stars"}`;

export const factsPending = (repo: Pick<LibraryRepo, "stars" | "pushedAt">) =>
  repo.stars === null && repo.pushedAt === null;

export const readingIncomplete = (enrichment: EnrichmentProgress) =>
  enrichment.read + enrichment.failed < enrichment.total;

export const fewNewStars = 20;

export type LastSync = "done" | "failed-first" | "failed-refresh";

export type Stage =
  | {
      readonly name: "importing";
      readonly done: number;
      readonly total: number | null;
      readonly read: number | null;
      readonly line: { readonly ahead: number; readonly startsAt: string } | null;
      // Nobody has asked for the import yet. The page asks once it is open in a visible tab.
      readonly starting: boolean;
    }
  | { readonly name: "refreshing"; readonly total: number; readonly arriving: number }
  | { readonly name: "reading"; readonly read: number; readonly settled: number; readonly total: number }
  | { readonly name: "ready"; readonly total: number; readonly failed: number; readonly lastSync: LastSync };

export const stageOf = ({
  sync,
  entries,
  starred,
}: {
  sync: SyncStatus | undefined;
  entries: ReadonlyArray<Pick<LibraryRepo, "stars" | "pushedAt">>;
  starred: number | null;
}): Stage => {
  const enrichment = sync?.enrichment ?? null;
  const pending = sync?.state === "queued" || sync?.state === "waiting";
  if ((pending || sync?.state === "unknown") && sync?.syncedAt === null)
    return {
      name: "importing",
      done: entries.length,
      total: starred === null ? null : Math.max(starred, entries.length),
      read: enrichment?.read ?? null,
      line: sync.waiting ?? null,
      starting: sync.state === "unknown",
    };
  const arriving = entries.filter(factsPending).length;
  const backlog = enrichment === null ? 0 : enrichment.total - enrichment.read - enrichment.failed;
  if (pending || (arriving > 0 && backlog > 0 && backlog <= fewNewStars))
    return { name: "refreshing", total: entries.length, arriving };
  if (enrichment !== null && readingIncomplete(enrichment))
    return {
      name: "reading",
      read: enrichment.read,
      settled: enrichment.read + enrichment.failed,
      total: enrichment.total,
    };
  const lastSync: LastSync =
    sync?.state !== "failed" ? "done" : sync.syncedAt === null ? "failed-first" : "failed-refresh";
  return { name: "ready", total: entries.length, failed: enrichment?.failed ?? 0, lastSync };
};

type Answer =
  | { readonly kind: "browsing" }
  | { readonly kind: "searching" }
  | { readonly kind: "found"; readonly count: number }
  | { readonly kind: "none" }
  | { readonly kind: "failed" };

export interface Status {
  readonly icon: StatusIcon;
  readonly label: string;
  readonly phoneLabel?: string;
  readonly detail?: string;
  readonly phoneDetail?: string;
  readonly continues?: boolean;
  readonly retry?: boolean;
  readonly instant?: boolean;
}

export interface Progress {
  readonly value: number;
  readonly max: number;
  readonly label: string;
  readonly text: string;
}

export interface EmptyCopy {
  readonly heading: string;
  readonly body: string;
  readonly meta?: string;
}

export type Body =
  | { readonly kind: "library" }
  | { readonly kind: "results"; readonly groups: ReadonlyArray<ResultGroup> }
  | { readonly kind: "empty-reading"; readonly copy: EmptyCopy; readonly ring: number | undefined }
  | { readonly kind: "empty"; readonly copy: EmptyCopy; readonly phrases: ReadonlyArray<string> }
  | { readonly kind: "failed"; readonly copy: EmptyCopy };

export interface SearchView {
  readonly status: Status;
  readonly progress: Progress | undefined;
  readonly pose: PipPose;
  readonly body: Body;
}

export interface Search {
  readonly terms: ReadonlyArray<string>;
  readonly words: ReadonlyArray<Result>;
  readonly meaning: ReadonlyArray<Result>;
  readonly pending: boolean;
  readonly failed: boolean;
  // Whether any star matches all of these words, so a suggestion never searches for words that find nothing.
  readonly hasMatches: (terms: ReadonlyArray<string>) => boolean;
}

const placeholdersAlone = 4;
const placeholdersAfter = 2;

type Underway = Extract<Stage, { name: "importing" | "reading" }>;

const partial = (stage: Stage): stage is Underway => stage.name === "importing" || stage.name === "reading";

const answerOf = ({ terms, words, meaning, pending, failed }: Search): Answer => {
  const found = words.length + meaning.length;
  if (terms.length === 0 && !pending && meaning.length === 0) return { kind: "browsing" };
  if (found > 0) return { kind: "found", count: found };
  if (pending) return { kind: "searching" };
  return failed ? { kind: "failed" } : { kind: "none" };
};

const unreadDetail = (stage: Stage) => {
  if (stage.name === "reading") return `${stars(stage.total - stage.read)} not read yet`;
  if (stage.name === "importing")
    return stage.total === null ? "more stars still arriving" : `${stars(stage.total - stage.done)} still arriving`;
  return undefined;
};

// Whose stars the page shows: undefined for the viewer's own, a login for anyone else's.
export type Whose = string | undefined;

const theirs = (whose: Whose) => (whose === undefined ? "your stars" : `@${whose}'s stars`);

const progressOf = (stage: Stage, whose: Whose): Progress | undefined => {
  if (stage.name === "importing" && stage.total !== null)
    return {
      value: stage.done,
      max: stage.total,
      label: `importing ${theirs(whose)}`,
      text: `${n(stage.done)} of ${n(stage.total)} imported`,
    };
  if (stage.name === "reading")
    return {
      value: stage.settled,
      max: stage.total,
      label: `reading ${theirs(whose)}`,
      text: `${n(stage.read)} of ${n(stage.total)} read`,
    };
  return undefined;
};

const withTime = (text: string, timeLeft: string | undefined) =>
  timeLeft === undefined ? text : `${text} · ${timeLeft}`;

const browsing = (stage: Stage, synced: string | undefined, timeLeft: string | undefined, whose: Whose): Status => {
  switch (stage.name) {
    case "importing":
      if (stage.starting)
        return {
          icon: "paused",
          label: `ready to import ${theirs(whose)}`,
          ...(whose === undefined ? {} : { phoneLabel: "ready to import" }),
        };
      if (stage.line !== null)
        return {
          icon: "busy",
          label: "in line to import",
          detail: withTime(stage.line.ahead === 0 ? "next up" : `${n(stage.line.ahead)} ahead`, timeLeft),
        };
      return {
        icon: "busy",
        label: `importing ${theirs(whose)}`,
        ...(whose === undefined ? {} : { phoneLabel: "importing" }),
        detail:
          stage.total === null
            ? `${n(stage.done)} imported so far`
            : withTime(`${n(stage.done)} of ${n(stage.total)}`, timeLeft),
      };
    case "refreshing":
      return stage.arriving === 0
        ? { icon: "busy", label: "checking for new stars" }
        : {
            icon: "busy",
            label: `${n(stage.arriving)} new ${stage.arriving === 1 ? "star" : "stars"}`,
            detail: "reading…",
          };
    case "reading":
      return {
        icon: "busy",
        label: `reading ${theirs(whose)}`,
        ...(whose === undefined ? {} : { phoneLabel: "reading" }),
        detail: `${n(stage.read)} of ${n(stage.total)} understood · names and descriptions already searchable`,
      };
    case "ready":
      if (stage.lastSync === "failed-refresh")
        return { icon: "failed", label: "couldn't check", detail: "for new stars", continues: true, retry: true };
      if (stage.lastSync === "failed-first")
        return { icon: "failed", label: "sync didn't finish", detail: `${stars(stage.total)} so far`, retry: true };
      return { icon: "synced", label: stars(stage.total), ...(synced === undefined ? {} : { detail: synced }) };
  }
};

const answered = (stage: Stage, answer: Exclude<Answer, { kind: "browsing" }>, whose: Whose): Status => {
  const detail = unreadDetail(stage);
  const rest = detail === undefined ? {} : { detail };
  switch (answer.kind) {
    case "searching":
      return { icon: "busy", label: "searching", ...rest };
    case "found":
      return partial(stage)
        ? { icon: "busy", label: `found ${n(answer.count)} so far`, ...rest }
        : whose === undefined
          ? { icon: "found", label: `found ${n(answer.count)}`, detail: `of ${n(stage.total)}`, continues: true }
          : {
              icon: "found",
              label: `found ${n(answer.count)}!`,
              detail: `in @${whose}'s ${stars(stage.total)}`,
              phoneDetail: `of ${stars(stage.total)}`,
            };
    case "none":
      if (partial(stage)) return { icon: "busy", label: "nothing yet", ...rest };
      return {
        icon: "done",
        label: "nothing found",
        detail:
          stage.name === "ready" && stage.failed > 0
            ? `${n(stage.total - stage.failed)} of ${n(stage.total)} stars read`
            : `all ${stars(stage.total)} read`,
      };
    case "failed":
      return { icon: "failed", label: "search didn't answer", detail: "try again in a moment" };
  }
};

const poseOf = (stage: Stage, answer: Answer): PipPose => {
  if (answer.kind === "failed") return "scared";
  if (answer.kind === "browsing" && stage.name === "ready" && stage.lastSync !== "done") return "scared";
  if (answer.kind === "searching") return "thinking";
  if (answer.kind === "none") return partial(stage) ? "unsure" : "sad";
  if (answer.kind === "found") return "idle";
  if (stage.name === "importing") return "happy";
  if (stage.name === "reading") return "thinking";
  return "idle";
};

const groupsOf = (stage: Stage, { words, meaning, pending }: Search): ReadonlyArray<ResultGroup> => {
  const found = words.length + meaning.length;
  const placeholders = pending ? (found === 0 ? placeholdersAlone : placeholdersAfter) : 0;
  if (!partial(stage)) return [{ key: "all", results: [...words, ...meaning], pending: placeholders }];
  const wordsHeading = {
    label: "matching words",
    detail:
      stage.name === "importing"
        ? `${n(words.length)} from the ${n(stage.done)} imported so far`
        : `${n(words.length)} from all ${n(stage.total)}`,
  };
  const meaningHeading = {
    label: "matching meaning",
    detail:
      stage.read === null
        ? `${n(meaning.length)} so far`
        : `${n(meaning.length)} from the ${n(stage.read)} read so far`,
  };
  return [
    ...(words.length > 0 ? [{ key: "words", heading: wordsHeading, results: words }] : []),
    ...(meaning.length > 0 || placeholders > 0
      ? [{ key: "meaning", heading: meaningHeading, results: meaning, pending: placeholders }]
      : []),
  ];
};

const rephrasings = ({ terms, hasMatches }: Search, limit = 3): ReadonlyArray<string> => {
  if (terms.length < 2) return [];
  const pairs = terms.length > 2 ? terms.slice(0, -1).map((_, index) => terms.slice(index, index + 2)) : [];
  const singles = terms
    .filter((term) => term.length > 2)
    .toSorted((a, b) => b.length - a.length)
    .map((term) => [term]);
  const phrases = [...pairs, ...singles].filter(hasMatches).map((words) => words.join(" "));
  return [...new Set(phrases)].slice(0, limit);
};

const notYetCopy = (stage: Underway, timeLeft: string | undefined, whose: Whose): EmptyCopy => {
  const meta = withTime("i'll search again when reading finishes", timeLeft);
  const read = stage.read ?? 0;
  if (read === 0)
    return {
      heading: `i haven't read ${theirs(whose)} yet`,
      body: "names and descriptions already match. the rest can match once i've read them.",
      meta,
    };
  const unread = stage.total === null ? undefined : stage.total - read;
  return {
    heading: `not in the ${n(read)} i've read yet`,
    body:
      unread === undefined
        ? "it might be in the stars still arriving."
        : `it might be in the ${stars(unread)} i'm still reading.`,
    meta,
  };
};

const nothingCopy = (stage: Exclude<Stage, Underway>, rephrased: boolean, whose: Whose): EmptyCopy => {
  const read = stage.name === "ready" && stage.failed > 0 ? "i've read every one i could" : "i've read all of them";
  const others = rephrased ? " try one of these:" : "";
  return {
    heading: `nothing in all ${stars(stage.total)}`,
    body: `${read}, and none matches that. maybe ${whose === undefined ? "you" : `@${whose}`} starred it under different words.${others}`,
  };
};

const failedCopy: EmptyCopy = {
  heading: "stargrep couldn't search that",
  body: "the search didn't answer. try again in a moment.",
};

const bodyOf = (
  stage: Stage,
  answer: Answer,
  search: Search,
  progress: Progress | undefined,
  timeLeft: string | undefined,
  whose: Whose,
): Body => {
  switch (answer.kind) {
    case "browsing":
      return { kind: "library" };
    case "searching":
    case "found":
      return { kind: "results", groups: groupsOf(stage, search) };
    case "failed":
      return { kind: "failed", copy: failedCopy };
    case "none": {
      if (partial(stage))
        return {
          kind: "empty-reading",
          copy: notYetCopy(stage, timeLeft, whose),
          ring: progress === undefined ? undefined : progress.value / Math.max(1, progress.max),
        };
      const phrases = rephrasings(search);
      return { kind: "empty", copy: nothingCopy(stage, phrases.length > 0, whose), phrases };
    }
  }
};

export const searchView = ({
  stage,
  search,
  synced,
  timeLeft,
  whose,
}: {
  stage: Stage;
  search: Search;
  synced: string | undefined;
  timeLeft: string | undefined;
  whose?: Whose;
}): SearchView => {
  const answer = answerOf(search);
  const progress = progressOf(stage, whose);
  return {
    status:
      answer.kind === "browsing"
        ? browsing(stage, synced, timeLeft, whose)
        : { ...answered(stage, answer, whose), instant: true },
    progress,
    pose: poseOf(stage, answer),
    body: bodyOf(stage, answer, search, progress, timeLeft, whose),
  };
};
