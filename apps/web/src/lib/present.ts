import type { Activity, RepoDetail, Result } from "@stargrep/ui";
import * as DateTime from "effect/DateTime";
import { highlights } from "./keyword.ts";
import type { LibraryEntry } from "./library-collection.ts";
import { repoVisual } from "./repo-visual.ts";

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

export const syncedAgo = (iso: string, at: number) => {
  const minutes = Math.floor((at - millis(iso)) / 60_000);
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes} min ago`;
  return `synced ${since(iso, at)}`;
};

const activity = (repo: LibraryEntry, at: number): Activity => {
  if (repo.archived) return { state: "archived" };
  if (repo.stars === null && repo.pushedAt === null) return { state: "reading" };
  if (repo.pushedAt === null) return { state: "quiet", label: "no pushes yet" };
  const label = `pushed ${since(repo.pushedAt, at)}`;
  return at - millis(repo.pushedAt) <= 30 * day ? { state: "alive", label } : { state: "quiet", label };
};

export const starredOn = (iso: string) => dateFormat.format(millis(iso));

export const monthOf = (iso: string) => monthFormat.format(millis(iso)).toLowerCase();

const reasonOf = (repo: LibraryEntry, read: boolean) =>
  (read ? (repo.summary ?? repo.description) : (repo.description ?? repo.summary)) ?? "";

export const toResult = (repo: LibraryEntry, terms: ReadonlyArray<string>, at: number, values = ""): Result => {
  const summary = reasonOf(repo, repo.read);
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
    unread: !repo.read,
  };
};

export const toDetail = (repo: LibraryEntry, at: number): RepoDetail => ({
  owner: repo.owner,
  name: repo.name,
  ...(repo.language === null ? {} : { language: repo.language }),
  description: repo.description ?? "",
  summary: repo.summary ?? repo.description ?? "",
  stars: repo.stars,
  starred: starredOn(repo.starredAt),
  activity: activity(repo, at),
  ...(repo.license === null ? {} : { license: repo.license }),
  network: [],
  alsoStarred: [],
  githubUrl: repo.url,
});
