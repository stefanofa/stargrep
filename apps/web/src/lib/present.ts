import type { Activity, RepoDetail, Result } from "@stargrep/ui";
import * as DateTime from "effect/DateTime";
import { highlights } from "./keyword.ts";
import type { LibraryEntry } from "./library-collection.ts";
import { repoVisual } from "./repo-visual.ts";
import { factsPending, type Whose } from "./search-state.ts";

const day = 86_400_000;
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const dateFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });
const count = new Intl.NumberFormat("en");

const millis = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

export const now = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

export const formatCount = (value: number) => count.format(value);

export const stars = (value: number) => `${count.format(value)} ${value === 1 ? "star" : "stars"}`;

const since = (iso: string, at: number) => {
  const days = Math.max(0, Math.floor((at - millis(iso)) / day));
  if (days < 7) return relative.format(-days, "day");
  if (days < 30) return relative.format(-Math.floor(days / 7), "week");
  if (days < 365) return relative.format(-Math.floor(days / 30), "month");
  return relative.format(-Math.floor(days / 365), "year");
};

export const startsIn = (iso: string, at: number) => {
  const minutes = Math.ceil((millis(iso) - at) / 60_000);
  if (minutes <= 1) return "starting any moment";
  if (minutes < 90) return `starts in about ${minutes} min`;
  return `starts in about ${Math.round(minutes / 60)} hours`;
};

export const syncedAgo = (iso: string, at: number) => {
  const minutes = Math.floor((at - millis(iso)) / 60_000);
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes} min ago`;
  return `synced ${since(iso, at)}`;
};

const activity = (repo: LibraryEntry, at: number): Activity => {
  if (repo.archived) return { state: "archived" };
  if (factsPending(repo)) return { state: "reading" };
  if (repo.pushedAt === null) return { state: "quiet", label: "no pushes yet" };
  const label = `pushed ${since(repo.pushedAt, at)}`;
  return at - millis(repo.pushedAt) <= 30 * day ? { state: "alive", label } : { state: "quiet", label };
};

export const starredOn = (iso: string) => dateFormat.format(millis(iso));

export const monthOf = (iso: string) => monthFormat.format(millis(iso)).toLowerCase();

const reasonOf = (repo: LibraryEntry) =>
  (repo.read ? (repo.summary ?? repo.description) : (repo.description ?? repo.summary)) ?? "";

export const toResult = (
  repo: LibraryEntry,
  at: number,
  {
    terms = [],
    values = "",
    flagUnread = true,
  }: { terms?: ReadonlyArray<string>; values?: string; flagUnread?: boolean } = {},
): Result => {
  const summary = reasonOf(repo);
  const reason = values === "" ? summary : [summary, values].filter((part) => part !== "").join(" · ");
  return {
    owner: repo.owner,
    name: repo.name,
    href: `?repo=${encodeURIComponent(`${repo.owner}/${repo.name}`)}`,
    reason,
    matches: highlights(reason, terms),
    activity: activity(repo, at),
    stars: repo.stars,
    starred: starredOn(repo.starredAt),
    network: [],
    visual: repoVisual(repo),
    language: repo.language,
    unread: flagUnread && !repo.read,
  };
};

export const toDetail = (repo: LibraryEntry, at: number, whose: Whose): RepoDetail => ({
  owner: repo.owner,
  name: repo.name,
  ...(repo.language === null ? {} : { language: repo.language }),
  description: repo.description ?? "",
  ...(repo.summary === null || repo.summary === repo.description ? {} : { summary: repo.summary }),
  stars: repo.stars,
  starred: { by: whose === undefined ? "you" : `@${whose}`, on: starredOn(repo.starredAt) },
  activity: activity(repo, at),
  ...(repo.license === null ? {} : { license: repo.license }),
  network: [],
  alsoStarred: [],
  githubUrl: repo.url,
  visual: repoVisual(repo),
});
