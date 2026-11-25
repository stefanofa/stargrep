import type { PipPose, Result, ResultGroup, TileProgress } from "@stargrep/ui";
import { type Audience, type Owner, pageKindOf, whoseOf } from "./audience.ts";
import { keywordTerms, normalize } from "./keyword.ts";
import type { LibraryRepo, SyncStatus } from "./rpc.ts";
import { readingIncomplete } from "./sync-status.ts";
import type { Trouble } from "./trouble.ts";
import { formatCount, starCount, theirs, type Whose } from "./whose.ts";

export const factsPending = (repo: Pick<LibraryRepo, "stars" | "pushedAt">) =>
  repo.stars === null && repo.pushedAt === null;

export const fewNewStars = 20;

export type LastSync = "done" | "failed-first" | "failed-refresh";

// Where a first import stands. Nobody asks for it until the page is open in a visible tab. Then it waits in line for
// GitHub budget, or runs.
export type ImportPhase =
  | { readonly kind: "not-asked" }
  | { readonly kind: "in-line"; readonly ahead: number; readonly startsAt: string }
  | { readonly kind: "running" };

export type Stage =
  | {
      readonly name: "importing";
      readonly done: number;
      readonly total: number | null;
      readonly read: number | null;
      readonly phase: ImportPhase;
    }
  | { readonly name: "refreshing"; readonly total: number; readonly arriving: number }
  | { readonly name: "reading"; readonly read: number; readonly settled: number; readonly total: number }
  | {
      readonly name: "ready";
      readonly total: number;
      readonly failed: number;
      // Repos whose summary waits for the daily summary cap or for the summary policy.
      readonly queued: number;
      readonly lastSync: LastSync;
    };

const importPhase = (sync: SyncStatus | undefined): ImportPhase | undefined => {
  if (sync === undefined || sync.syncedAt !== null) return undefined;
  switch (sync.state) {
    case "unknown":
      return { kind: "not-asked" };
    case "waiting":
      return { kind: "in-line", ...sync.waiting };
    case "queued":
      return { kind: "running" };
    default:
      return undefined;
  }
};

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
  const phase = importPhase(sync);
  if (phase !== undefined)
    return {
      name: "importing",
      done: entries.length,
      total: starred === null ? null : Math.max(starred, entries.length),
      read: enrichment?.read ?? null,
      phase,
    };
  const pending = sync?.state === "queued" || sync?.state === "waiting";
  const arriving = entries.filter(factsPending).length;
  const backlog = enrichment === null ? 0 : enrichment.total - enrichment.read - enrichment.failed - enrichment.queued;
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
  return {
    name: "ready",
    total: entries.length,
    failed: enrichment?.failed ?? 0,
    queued: enrichment?.queued ?? 0,
    lastSync,
  };
};

// Why the search by meaning gave no answer: it failed, or the network asked too often.
type Missed = "failed" | "limited";

type Answer =
  | { readonly kind: "browsing" }
  | { readonly kind: "searching" }
  | { readonly kind: "found"; readonly count: number; readonly missed: Missed | undefined }
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly missed: Missed };

export type Retry = "sync" | "library" | "search";

// What the strip says about the answer on screen. Browsing says nothing, since the library speaks for itself and the
// rail shows an import or a read. A failure says so and offers to try again.
export interface Status {
  readonly label: string;
  // A shorter label for the phone's strip, which shares one line with the filters.
  readonly phoneLabel?: string;
  readonly retry?: Retry;
}

export interface EmptyCopy {
  readonly heading: string;
  readonly body: string;
  readonly meta?: string;
}

export interface Arriving {
  readonly total: number | null;
}

export type Body =
  | { readonly kind: "loading"; readonly searching: boolean; readonly arriving: Arriving | undefined }
  | { readonly kind: "library"; readonly arriving: Arriving | undefined }
  | { readonly kind: "results"; readonly groups: ReadonlyArray<ResultGroup> }
  | { readonly kind: "empty-reading"; readonly copy: EmptyCopy; readonly ring: number | undefined }
  | { readonly kind: "empty"; readonly copy: EmptyCopy; readonly phrases: ReadonlyArray<string> }
  | { readonly kind: "failed"; readonly copy: EmptyCopy }
  | {
      readonly kind: "trouble";
      readonly heading: string;
      readonly detail: string;
      readonly retry: Retry | undefined;
      // Where to go instead, when trying again can't help.
      readonly offer: "people" | undefined;
    };

export interface SearchView {
  readonly status: Status | undefined;
  readonly progress: TileProgress | undefined;
  readonly pose: PipPose;
  readonly body: Body;
}

export interface Search {
  readonly terms: ReadonlyArray<string>;
  readonly words: ReadonlyArray<Result>;
  // While the search by meaning is pending, these are an earlier query's results.
  readonly meaning: ReadonlyArray<Result>;
  readonly semantic: "none" | "pending" | "answered" | Missed;
  // Whether any star matches all of these words, so a suggestion never searches for words that find nothing.
  readonly hasMatches: (terms: ReadonlyArray<string>) => boolean;
}

const placeholdersAlone = 4;
const placeholdersAfter = 2;

type Importing = Extract<Stage, { name: "importing" }>;

type Underway = Extract<Stage, { name: "importing" | "reading" }>;

const partial = (stage: Stage): stage is Underway => stage.name === "importing" || stage.name === "reading";

const answerOf = ({ terms, words, meaning, semantic }: Search): Answer => {
  if (terms.length === 0 && semantic !== "pending" && meaning.length === 0) return { kind: "browsing" };
  // An earlier query's results stay on screen, but they don't answer this one.
  if (semantic === "pending" && meaning.length > 0) return { kind: "searching" };
  if (semantic === "failed" || semantic === "limited")
    return words.length > 0
      ? { kind: "found", count: words.length, missed: semantic }
      : { kind: "failed", missed: semantic };
  const found = words.length + meaning.length;
  if (found > 0) return { kind: "found", count: found, missed: undefined };
  return semantic === "pending" ? { kind: "searching" } : { kind: "none" };
};

// What the strip adds to the keyword matches when the search by meaning gave no answer. Phones say it shorter.
const missedStatus: Record<Missed, { readonly label: string; readonly phoneLabel: string }> = {
  failed: { label: "meaning search didn't answer", phoneLabel: "meaning failed" },
  limited: { label: "meaning search is taking a breather", phoneLabel: "taking a breather" },
};

const progressOf = (stage: Stage, whose: Whose): TileProgress | undefined => {
  if (stage.name === "importing" && stage.total !== null)
    return {
      value: stage.done,
      max: stage.total,
      label: `importing ${theirs(whose)}`,
      text: `${formatCount(stage.done)} of ${formatCount(stage.total)} imported`,
    };
  if (stage.name === "reading")
    return {
      value: stage.settled,
      max: stage.total,
      label: `reading ${theirs(whose)}`,
      text: `${formatCount(stage.read)} of ${formatCount(stage.total)} read`,
    };
  return undefined;
};

const withTime = (text: string, timeLeft: string | undefined) =>
  timeLeft === undefined ? text : `${text} · ${timeLeft}`;

// Browsing says nothing about the pipeline. Only a sync that failed says so, with a way to try again.
const browsing = (stage: Stage): Status | undefined => {
  if (stage.name !== "ready" || stage.lastSync === "done") return undefined;
  return stage.lastSync === "failed-refresh"
    ? { label: "couldn't check for new stars", phoneLabel: "couldn't check", retry: "sync" }
    : { label: "sync didn't finish", retry: "sync" };
};

const answered = (stage: Stage, answer: Exclude<Answer, { kind: "browsing" }>): Status => {
  switch (answer.kind) {
    case "searching":
      return { label: "searching…" };
    case "found": {
      const found = `found ${formatCount(answer.count)}`;
      if (answer.missed !== undefined) {
        const missed = missedStatus[answer.missed];
        return { label: `${found} · ${missed.label}`, phoneLabel: `${found} · ${missed.phoneLabel}`, retry: "search" };
      }
      return { label: partial(stage) ? `${found} so far` : `${found}!` };
    }
    case "none":
      return { label: partial(stage) ? "nothing yet" : "nothing found" };
    case "failed":
      return answer.missed === "limited"
        ? { label: "taking a breather", retry: "search" }
        : { label: "search didn't answer", phoneLabel: "search failed", retry: "search" };
  }
};

const poseOf = (stage: Stage, answer: Answer): PipPose => {
  const missed = answer.kind === "failed" || answer.kind === "found" ? answer.missed : undefined;
  if (missed !== undefined) return missed === "limited" ? "unsure" : "scared";
  if (answer.kind === "browsing" && stage.name === "ready" && stage.lastSync !== "done") return "scared";
  if (answer.kind === "searching") return "thinking";
  if (answer.kind === "none") return partial(stage) ? "unsure" : "sad";
  if (answer.kind === "found") return "idle";
  if (stage.name === "importing") return "happy";
  if (stage.name === "reading") return "thinking";
  return "idle";
};

const groupsOf = (stage: Stage, { words, meaning, semantic }: Search): ReadonlyArray<ResultGroup> => {
  const found = words.length + meaning.length;
  const placeholders = semantic === "pending" ? (found === 0 ? placeholdersAlone : placeholdersAfter) : 0;
  if (!partial(stage)) return [{ key: "all", results: [...words, ...meaning], pending: placeholders }];
  const wordsHeading = {
    label: "matching words",
    detail:
      stage.name === "importing"
        ? `${formatCount(words.length)} from the ${formatCount(stage.done)} imported so far`
        : `${formatCount(words.length)} from all ${formatCount(stage.total)}`,
  };
  const meaningHeading = {
    label: "matching meaning",
    detail:
      stage.read === null
        ? `${formatCount(meaning.length)} so far`
        : `${formatCount(meaning.length)} from the ${formatCount(stage.read)} read so far`,
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
    heading: `not in the ${formatCount(read)} i've read yet`,
    body:
      unread === undefined
        ? "it might be in the stars still arriving."
        : `it might be in the ${starCount(unread)} i'm still reading.`,
    meta,
  };
};

const nothingCopy = (stage: Exclude<Stage, Underway>, rephrased: boolean, whose: Whose): EmptyCopy => {
  const read = stage.name === "ready" && stage.failed > 0 ? "i've read every one i could" : "i've read all of them";
  const others = rephrased ? " try one of these:" : "";
  return {
    heading: `nothing in all ${starCount(stage.total)}`,
    body: `${read}, and none matches that. maybe ${whose.own ? "you" : `@${whose.login}`} starred it under different words.${others}`,
  };
};

const failedCopy: Record<Missed, EmptyCopy> = {
  failed: { heading: "stargrep couldn't search that", body: "the search didn't answer. try again in a moment." },
  limited: { heading: "lots of searches from your network", body: "give it a minute, then try again." },
};

const arrivingOf = (stage: Stage): Arriving | undefined =>
  stage.name === "importing" ? { total: stage.total } : undefined;

const bodyOf = (
  stage: Stage,
  answer: Answer,
  search: Search,
  progress: TileProgress | undefined,
  timeLeft: string | undefined,
  whose: Whose,
): Body => {
  switch (answer.kind) {
    case "browsing":
      return { kind: "library", arriving: arrivingOf(stage) };
    case "searching":
    case "found":
      return { kind: "results", groups: groupsOf(stage, search) };
    case "failed":
      return { kind: "failed", copy: failedCopy[answer.missed] };
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
  timeLeft,
  whose,
}: {
  stage: Stage;
  search: Search;
  timeLeft: string | undefined;
  whose: Whose;
}): SearchView => {
  const answer = answerOf(search);
  const progress = progressOf(stage, whose);
  return {
    status: answer.kind === "browsing" ? browsing(stage) : answered(stage, answer),
    progress,
    pose: poseOf(stage, answer),
    body: bodyOf(stage, answer, search, progress, timeLeft, whose),
  };
};

interface TroubleCopy {
  readonly heading: string;
  readonly detail: string;
  readonly pose: PipPose;
  // A login GitHub doesn't know is a dead end, so it offers nothing to try again, and the people list instead.
  readonly retry: Retry | undefined;
  readonly offer?: "people";
}

const troubleCopy = (trouble: Trouble, owner: string, whose: Whose): TroubleCopy => {
  switch (trouble) {
    case "missing":
      return {
        heading: `GitHub has no one called @${owner}`,
        detail: "check the spelling, or pick someone from people.",
        pose: "unsure",
        retry: undefined,
        offer: "people",
      };
    case "busy":
      return {
        heading: "github's line for new imports is full",
        detail: `stargrep can read ${theirs(whose)} once there's room. try again in a while.`,
        pose: "unsure",
        retry: "sync",
      };
    case "limited":
      return {
        heading: "lots of requests from your network",
        detail: "give it a few minutes, then try again. accounts stargrep already knows still work.",
        pose: "unsure",
        retry: "sync",
      };
    case "unavailable":
      return {
        heading: "stargrep couldn't reach GitHub just now",
        detail: `${theirs(whose)} can import once it answers. try again in a moment.`,
        pose: "unsure",
        retry: "sync",
      };
    case "load-limited":
      return {
        heading: "lots of requests from your network",
        detail: "give it a minute, then try again.",
        pose: "unsure",
        retry: "library",
      };
    case "load-failed":
      return {
        heading: `stargrep couldn't load ${theirs(whose)}`,
        detail: "the library didn't arrive. try again in a moment.",
        pose: "scared",
        retry: "library",
      };
  }
};

// The butter tile asks a visitor to sign in. While someone's stars import, it asks whether the visitor is them, since
// owners skip the line, and rings Pip with the import's progress.
export type Butter = { readonly kind: "join" } | { readonly kind: "claim"; readonly progress: number };

// A login the subtitle names, which the hero links to its GitHub profile.
export type Mention = { readonly login: string };

export interface HeroCopy {
  readonly subtitle: ReadonlyArray<string | Mention>;
  readonly butter: Butter;
}

const importProgress = (stage: Importing) => (stage.total === null ? 0 : stage.done / Math.max(1, stage.total));

// What the hero says above a visitor's look at the demo account. While the demo's stars import, as on a fresh stage,
// the butter tile becomes the claim tile, with the import's progress, so the subtitle stays put while it ticks.
const heroCopy = (stage: Stage, troubled: boolean, owner: Owner): HeroCopy => {
  if (troubled) return { subtitle: ["try any username."], butter: { kind: "join" } };
  const mention = { login: owner.login };
  if (stage.name === "importing") {
    const rest = {
      "not-asked": " is new here. their stars are ready to import from GitHub, and search covers them as they land.",
      "in-line": " is new here and waits in line for GitHub. search covers their stars as they land.",
      running: " is new here. their stars are on the way from GitHub, and search covers the ones that landed.",
    }[stage.phase.kind];
    return { subtitle: [mention, rest], butter: { kind: "claim", progress: importProgress(stage) } };
  }
  return {
    subtitle: ["live results from ", mention, ", our demo account. try any username."],
    butter: { kind: "join" },
  };
};

// The person tile above every stars page but the landing, your own included.
export interface PersonCopy {
  readonly login: string;
  // GitHub knows the login, so the tile shows their avatar and links to their profile.
  readonly known: boolean;
}

// The example speaks as the viewer, so it fits only their own stars. Anyone else's stars name whose they are.
const idlePlaceholder = (whose: Whose) =>
  whose.own ? "the rust tui library i starred last year" : `search ${theirs(whose)}`;

export interface PageView extends SearchView {
  // The page still shows the answer the server painted.
  readonly painted: boolean;
  // Only the landing has the hero.
  readonly hero: HeroCopy | undefined;
  // Every page but the landing has the person tile.
  readonly person: PersonCopy | undefined;
  readonly placeholder: string;
}

export interface PageInputs {
  readonly audience: Audience;
  readonly query: string;
  readonly stage: Stage;
  // What the library shows for the query, once it has loaded.
  readonly live: SearchView;
  // The server's answer for its query, painted before the library loads.
  readonly first: { readonly query: string; readonly view: SearchView } | undefined;
  readonly library: { readonly ready: boolean; readonly whole: boolean };
  readonly trouble: Trouble | undefined;
  // Results by meaning just landed, which surprises an idle Pip for a moment.
  readonly surprised: boolean;
}

// What a stars page shows. Trouble wins over everything. Then the server's first answer holds until the library has
// every page, since a view of the first page alone can read differently, such as "found 20 so far" for a library still
// reading. Then the library's own view, once it has loaded.
export const pageView = ({
  audience,
  query,
  stage,
  live,
  first,
  library,
  trouble,
  surprised,
}: PageInputs): PageView => {
  const whose = whoseOf(audience);
  const kind = pageKindOf(audience);
  const painted =
    first !== undefined && !(library.ready && library.whole) && normalize(query) === normalize(first.query);
  const shown = painted ? first.view : library.ready ? live : undefined;
  const page = {
    painted,
    hero: kind === "landing" ? heroCopy(stage, trouble !== undefined, audience.owner) : undefined,
    person: kind === "landing" ? undefined : { login: audience.owner.login, known: trouble !== "missing" },
    placeholder: stage.name === "importing" ? "search what has arrived" : idlePlaceholder(whose),
    progress: shown?.progress,
  };
  if (trouble !== undefined) {
    const { heading, detail, pose, retry, offer } = troubleCopy(trouble, audience.owner.login, whose);
    return { ...page, status: undefined, pose, body: { kind: "trouble", heading, detail, retry, offer } };
  }
  const calm = (shown ?? live).pose;
  const pose = surprised && calm === "idle" ? "surprised" : calm;
  if (shown === undefined)
    return {
      ...page,
      status: undefined,
      pose,
      body: { kind: "loading", searching: keywordTerms(query).length > 0, arriving: arrivingOf(stage) },
    };
  return { ...page, status: shown.status, pose, body: shown.body };
};
