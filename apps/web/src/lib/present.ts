import type { Activity, RepoDetail, Result, ResultGroup, SimilarItem, SimilarRow, Stargazer } from "@stargrep/ui";
import { defaultStringifySearch } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { highlights } from "./keyword.ts";
import type { LibraryEntry } from "./library-collection.ts";
import { repoVisual } from "./repo-visual.ts";
import type { LibraryRepo, SimilarRepo, SimilarRepos } from "./rpc.ts";
import type { Params } from "./search-params.ts";
import { factsPending } from "./search-state.ts";
import { loginHref } from "./stars-route.ts";
import { theirs, type Whose } from "./whose.ts";

const day = 86_400_000;
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const dateFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });

const millis = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

export const now = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

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

const activity = (repo: Pick<LibraryRepo, "archived" | "stars" | "pushedAt">, at: number): Activity => {
  if (repo.archived) return { state: "archived" };
  if (factsPending(repo)) return { state: "reading" };
  if (repo.pushedAt === null) return { state: "quiet", label: "no pushes yet" };
  const label = `pushed ${since(repo.pushedAt, at)}`;
  return at - millis(repo.pushedAt) <= 30 * day ? { state: "alive", label } : { state: "quiet", label };
};

export const starredOn = (iso: string) => dateFormat.format(millis(iso));

export const monthOf = (iso: string) => monthFormat.format(millis(iso)).toLowerCase();

// A result's link opens its repo over the page it was found on, with the same query, view and sort, so a new tab or a
// copied link lands on the same state.
const repoHref = (search: Params, repo: Pick<Result, "owner" | "name">) =>
  defaultStringifySearch({ ...search, error: undefined, repo: `${repo.owner}/${repo.name}` });

export const withLinks = (groups: ReadonlyArray<ResultGroup>, search: Params): ReadonlyArray<ResultGroup> =>
  groups.map((group) => ({
    ...group,
    results: group.results.map((result) => ({ ...result, href: repoHref(search, result) })),
  }));

const reasonOf = (repo: LibraryEntry) =>
  (repo.read ? (repo.summary ?? repo.description) : (repo.description ?? repo.summary)) ?? "";

export const toResult = (
  repo: LibraryEntry,
  at: number,
  {
    search = {},
    terms = [],
    values = "",
    flagUnread = true,
  }: { search?: Params; terms?: ReadonlyArray<string>; values?: string; flagUnread?: boolean } = {},
): Result => {
  const summary = reasonOf(repo);
  const reason = values === "" ? summary : [summary, values].filter((part) => part !== "").join(" · ");
  return {
    owner: repo.owner,
    name: repo.name,
    href: repoHref(search, repo),
    reason,
    matches: highlights(reason, terms),
    activity: activity(repo, at),
    stars: repo.stars,
    starred: starredOn(repo.starredAt),
    network: [],
    visual: repoVisual(repo, "card"),
    language: repo.language,
    unread: flagUnread && !repo.read,
  };
};

type Shown = Pick<
  LibraryRepo,
  | "owner"
  | "name"
  | "language"
  | "description"
  | "summary"
  | "stars"
  | "archived"
  | "pushedAt"
  | "license"
  | "url"
  | "icon"
  | "ownerType"
  | "ownerAvatarUrl"
>;

// The panel for a repo the login hasn't starred, such as one opened from its "more like this" row.
export const strayDetail = (repo: Shown, at: number): RepoDetail => ({
  owner: repo.owner,
  name: repo.name,
  ...(repo.language === null ? {} : { language: repo.language }),
  description: repo.description ?? "",
  ...(repo.summary === null || repo.summary === repo.description ? {} : { summary: repo.summary }),
  stars: repo.stars,
  activity: activity(repo, at),
  ...(repo.license === null ? {} : { license: repo.license }),
  network: [],
  githubUrl: repo.url,
  visual: repoVisual(repo, "panel"),
});

export const toDetail = (repo: LibraryEntry, at: number, whose: Whose): RepoDetail => ({
  ...strayDetail(repo, at),
  starred: { by: whose.own ? "you" : `@${whose.login}`, on: starredOn(repo.starredAt) },
});

export type SimilarRowKey = "in_stars" | "not_starred";

const similarItem = (repo: SimilarRepo, search: Params): SimilarItem => ({
  owner: repo.owner,
  name: repo.name,
  line: repo.summary ?? repo.description ?? "",
  href: repoHref(search, repo),
  visual: repoVisual(repo, "row"),
});

// The rows under the panel's link to GitHub, from the answer once it lands. No rows when the answer failed. The first
// row names whose stars it searched, since on someone else's page they aren't the viewer's.
export const similarRows = (
  answer: SimilarRepos | "loading" | undefined,
  search: Params,
  whose: Whose,
): ReadonlyArray<SimilarRow<SimilarRowKey>> => {
  if (answer === undefined) return [];
  const row = (repos: ReadonlyArray<SimilarRepo> | undefined) =>
    repos === undefined ? ("loading" as const) : repos.map((repo) => similarItem(repo, search));
  const loaded = answer === "loading" ? undefined : answer;
  return [
    { key: "in_stars", heading: `also in ${theirs(whose)}`, repos: row(loaded?.inStars) },
    { key: "not_starred", heading: "more like this", repos: row(loaded?.notStarred) },
  ];
};

// GitHub serves an avatar at any size, and the panel's faces are 32px.
const faceUrl = (avatarUrl: string) => {
  const url = URL.parse(avatarUrl);
  url?.searchParams.set("s", "64");
  return url?.href ?? avatarUrl;
};

// The people the panel says also star the repo, once the answer lands. No one while it loads or when it failed.
export const stargazers = (
  answer: SimilarRepos | "loading" | undefined,
): { readonly people: ReadonlyArray<Stargazer>; readonly total: number } => {
  if (answer === undefined || answer === "loading") return { people: [], total: 0 };
  const { people, total } = answer.starredBy;
  return {
    people: people.map((person) => ({
      login: person.login,
      ...(person.avatarUrl === null ? {} : { avatarUrl: faceUrl(person.avatarUrl) }),
      href: loginHref(person.login),
    })),
    total,
  };
};
