import type { Activity, RepoDetail } from "@stargrep/ui";
import { repoVisual } from "./repo-visual.ts";
import type { SearchResult } from "./rpc.ts";

type Shown = Pick<
  SearchResult,
  | "owner"
  | "name"
  | "language"
  | "description"
  | "summary"
  | "license"
  | "url"
  | "archived"
  | "pushedAt"
  | "icon"
  | "ownerType"
  | "ownerAvatarUrl"
>;

const day = 86_400_000;
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

// How long ago a push was, in the largest whole unit, as the stars page says it.
const since = (iso: string, at: number) => {
  const days = Math.max(0, Math.floor((at - Date.parse(iso)) / day));
  if (days < 7) return relative.format(-days, "day");
  if (days < 30) return relative.format(-Math.floor(days / 7), "week");
  if (days < 365) return relative.format(-Math.floor(days / 30), "month");
  return relative.format(-Math.floor(days / 365), "year");
};

const activity = (repo: Shown, at: number): Activity => {
  if (repo.archived) return { state: "archived" };
  if (repo.pushedAt === null) return { state: "quiet", label: "no pushes yet" };
  const label = `pushed ${since(repo.pushedAt, at)}`;
  return at - Date.parse(repo.pushedAt) <= 30 * day ? { state: "alive", label } : { state: "quiet", label };
};

// The repo panel for a repo on a page that carries no Effect, so it reads times with the platform's own.
export const plainDetail = (repo: Shown, stars: number | null, at: number): RepoDetail => ({
  owner: repo.owner,
  name: repo.name,
  ...(repo.language === null ? {} : { language: repo.language }),
  description: repo.description ?? "",
  ...(repo.summary === null || repo.summary === repo.description ? {} : { summary: repo.summary }),
  stars,
  activity: activity(repo, at),
  ...(repo.license === null ? {} : { license: repo.license }),
  network: [],
  githubUrl: repo.url,
  visual: repoVisual(repo, "panel"),
});
