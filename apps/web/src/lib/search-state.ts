import type { PipPose, StatusIcon } from "@stargrep/ui";
import type { Enrichment } from "./planned.ts";

const count = new Intl.NumberFormat("en");
const n = (value: number) => count.format(value);
const stars = (value: number) => `${n(value)} ${value === 1 ? "star" : "stars"}`;

export type Stage =
  | { readonly name: "importing"; readonly done: number; readonly total: number | null; readonly read: number | null }
  | { readonly name: "reading"; readonly read: number; readonly settled: number; readonly total: number }
  | { readonly name: "ready"; readonly total: number; readonly failed: number };

export const stageOf = ({
  importing,
  imported,
  starred,
  enrichment,
}: {
  importing: boolean;
  imported: number;
  starred: number | null;
  enrichment: Enrichment | null;
}): Stage => {
  if (importing)
    return {
      name: "importing",
      done: imported,
      total: starred === null ? null : Math.max(starred, imported),
      read: enrichment?.read ?? null,
    };
  if (enrichment !== null && enrichment.read + enrichment.failed < enrichment.total)
    return {
      name: "reading",
      read: enrichment.read,
      settled: enrichment.read + enrichment.failed,
      total: enrichment.total,
    };
  return { name: "ready", total: imported, failed: enrichment?.failed ?? 0 };
};

export type Answer =
  | { readonly kind: "browsing" }
  | { readonly kind: "searching" }
  | { readonly kind: "found"; readonly count: number }
  | { readonly kind: "none" }
  | { readonly kind: "failed" };

export const answerOf = ({
  searching,
  found,
  pending,
  failed,
}: {
  searching: boolean;
  found: number;
  pending: boolean;
  failed: boolean;
}): Answer => {
  if (!searching) return { kind: "browsing" };
  if (found > 0) return { kind: "found", count: found };
  if (pending) return { kind: "searching" };
  return failed ? { kind: "failed" } : { kind: "none" };
};

export interface Status {
  readonly icon: StatusIcon;
  readonly label: string;
  readonly detail?: string;
  readonly retry?: boolean;
}

export type Body = "library" | "results" | "empty-reading" | "empty" | "failed";

export interface SearchView {
  readonly status: Status;
  readonly rail: number | undefined;
  readonly pose: PipPose;
  readonly body: Body;
}

const partial = (stage: Stage) => stage.name !== "ready";

const unreadDetail = (stage: Stage) => {
  if (stage.name === "reading") return `${stars(stage.total - stage.read)} not read yet`;
  if (stage.name === "importing")
    return stage.total === null ? "more stars still arriving" : `${stars(stage.total - stage.done)} still arriving`;
  return undefined;
};

const railOf = (stage: Stage) => {
  if (stage.name === "importing") return stage.total === null ? undefined : stage.done / Math.max(1, stage.total);
  if (stage.name === "reading") return stage.settled / Math.max(1, stage.total);
  return undefined;
};

const browsing = (stage: Stage, synced: string | undefined, syncFailed: boolean, timeLeft: string): Status => {
  if (stage.name === "importing")
    return {
      icon: "busy",
      label: "importing your stars",
      detail:
        stage.total === null
          ? `${n(stage.done)} imported so far`
          : `${n(stage.done)} of ${n(stage.total)} · ${timeLeft}`,
    };
  if (stage.name === "reading")
    return {
      icon: "busy",
      label: "reading your stars",
      detail: `${n(stage.read)} of ${n(stage.total)} understood · names and descriptions already searchable`,
    };
  if (syncFailed)
    return { icon: "failed", label: "sync didn't finish", detail: `${stars(stage.total)} so far`, retry: true };
  return { icon: "synced", label: stars(stage.total), ...(synced === undefined ? {} : { detail: synced }) };
};

const answered = (stage: Stage, answer: Exclude<Answer, { kind: "browsing" }>): Status => {
  const detail = unreadDetail(stage);
  const rest = detail === undefined ? {} : { detail };
  switch (answer.kind) {
    case "searching":
      return { icon: "busy", label: "searching", ...rest };
    case "found":
      return stage.name === "ready"
        ? { icon: "found", label: `found ${n(answer.count)}`, detail: `of ${n(stage.total)}` }
        : { icon: "busy", label: `found ${n(answer.count)} so far`, ...rest };
    case "none":
      if (stage.name !== "ready") return { icon: "busy", label: "nothing yet", ...rest };
      return {
        icon: "done",
        label: "nothing found",
        detail:
          stage.failed > 0
            ? `${n(stage.total - stage.failed)} of ${n(stage.total)} stars read`
            : `all ${stars(stage.total)} read`,
      };
    case "failed":
      return { icon: "failed", label: "search didn't answer", detail: "try again in a moment" };
  }
};

const poseOf = (stage: Stage, answer: Answer, syncFailed: boolean): PipPose => {
  if (answer.kind === "failed" || (answer.kind === "browsing" && syncFailed && stage.name === "ready")) return "scared";
  if (answer.kind === "searching") return "thinking";
  if (answer.kind === "none") return partial(stage) ? "unsure" : "sad";
  if (answer.kind === "found") return "idle";
  if (stage.name === "importing") return "happy";
  if (stage.name === "reading") return "thinking";
  return "idle";
};

const bodyOf = (stage: Stage, answer: Answer): Body => {
  if (answer.kind === "browsing") return "library";
  if (answer.kind === "none") return partial(stage) ? "empty-reading" : "empty";
  if (answer.kind === "failed") return "failed";
  return "results";
};

export const searchView = ({
  stage,
  answer,
  synced,
  syncFailed,
  timeLeft,
}: {
  stage: Stage;
  answer: Answer;
  synced: string | undefined;
  syncFailed: boolean;
  timeLeft: string;
}): SearchView => ({
  status: answer.kind === "browsing" ? browsing(stage, synced, syncFailed, timeLeft) : answered(stage, answer),
  rail: railOf(stage),
  pose: poseOf(stage, answer, syncFailed),
  body: bodyOf(stage, answer),
});

export interface Headings {
  readonly words: { readonly label: string; readonly detail: string };
  readonly meaning: { readonly label: string; readonly detail: string };
}

export const headingsOf = (stage: Stage, words: number, meaning: number): Headings | undefined => {
  if (stage.name === "ready") return undefined;
  const read = stage.read;
  return {
    words: {
      label: "matching words",
      detail:
        stage.name === "importing"
          ? `${n(words)} from the ${n(stage.done)} imported so far`
          : `${n(words)} from all ${n(stage.total)}`,
    },
    meaning: {
      label: "matching meaning",
      detail: read === null ? `${n(meaning)} so far` : `${n(meaning)} from the ${n(read)} read so far`,
    },
  };
};

export interface Unread {
  readonly read: number;
  readonly unread: number;
  readonly total: number;
}

export const unreadOf = (stage: Stage): Unread | undefined => {
  if (stage.name === "reading") return { read: stage.read, unread: stage.total - stage.read, total: stage.total };
  if (stage.name === "importing" && stage.total !== null)
    return { read: stage.read ?? 0, unread: stage.total - (stage.read ?? 0), total: stage.total };
  return undefined;
};

// Shorter phrasings of a query that found nothing, from its own words: each adjacent pair, then the longest single
// words. Two words match more often than five, since a keyword hit needs every word.
export const rephrasings = (terms: ReadonlyArray<string>, limit = 3): ReadonlyArray<string> => {
  if (terms.length < 2) return [];
  const pairs = terms.length > 2 ? terms.slice(1).map((term, index) => `${terms[index]} ${term}`) : [];
  const singles = terms.toSorted((a, b) => b.length - a.length);
  return [...new Set([...pairs, ...singles])].slice(0, limit);
};
