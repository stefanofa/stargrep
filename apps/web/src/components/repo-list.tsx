import { formatStars, RepoIcon, Skeleton, Tile } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import type { MouseEvent, ReactNode } from "react";
import { repoVisual } from "../lib/repo-visual.ts";
import type { SearchResult, TopicRepo } from "../lib/rpc.ts";
import { formatCount } from "../lib/whose.ts";
import { textLinkClass } from "./external-text-link.tsx";

// A repo a list shows: one a topic ranks, which says how many people here star it, or one a search found.
export type ListedRepo = TopicRepo | SearchResult;

export type OpenListed = (repo: ListedRepo, opener: HTMLElement) => void;

const plainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

const line = (repo: ListedRepo) => repo.summary ?? repo.description ?? "";

// Rows sit under a rule each. The rule belongs to the item, so the link's rounded focus ring never bends it.
const rule = "border-t-[1.5px] border-muted";
const row = "flex min-w-0 items-center gap-3 py-3 sm:gap-3.5";

// One repo: its place, icon, name, owner and one line about it, then how many people here and on GitHub star it, which
// phones fold into the owner's line to give the summary two lines. The
// link opens the repo panel through ?repo=, so a plain click opens it in place and any other click opens the page with
// the panel open.
function RepoRow({ repo, place, onOpen }: { repo: ListedRepo; place: number | undefined; onOpen: OpenListed }) {
  const ranked = "devs" in repo;
  return (
    <li className={rule}>
      <Link
        to="."
        search={(previous) => ({ ...previous, repo: `${repo.owner}/${repo.name}` })}
        onClick={(event) => {
          if (!plainClick(event)) return;
          event.preventDefault();
          onOpen(repo, event.currentTarget);
        }}
        className={`group ${row} rounded-xs focus-visible:-outline-offset-2`}
      >
        {/* The list is ordered, so a screen reader already says the place. */}
        {place !== undefined && (
          <span
            aria-hidden
            className="w-[22px] shrink-0 font-display text-[16px] leading-5 font-semibold text-muted-foreground tabular-nums"
          >
            {place}
          </span>
        )}
        <RepoIcon visual={repoVisual(repo, "row")} size="row" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-display text-[18px] leading-[22px] font-semibold transition-colors duration-120 group-hover:text-accent-strong">
            {repo.name}
            <span className="font-sans text-sm font-normal text-muted-foreground">
              {` ${repo.owner}`}
              {ranked && <span className="sm:hidden">{` · ${formatCount(repo.devs)} people`}</span>}
            </span>
          </span>
          {line(repo) !== "" && (
            <span className="font-sans text-meta leading-[19px] text-secondary-foreground max-sm:line-clamp-2 sm:truncate">
              {line(repo)}
            </span>
          )}
        </span>
        {ranked && (
          <span className="min-w-[150px] shrink-0 text-right font-sans text-sm whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden">
            {`${formatCount(repo.devs)} people`}
            {repo.stars !== null && ` · ★ ${formatStars(repo.stars)}`}
          </span>
        )}
      </Link>
    </li>
  );
}

const placeholders = 4;

// Rows the size of the ones that replace them.
function PlaceholderRows() {
  return (
    <ul aria-hidden className="flex flex-col">
      {Array.from({ length: placeholders }, (_, index) => (
        <li key={index} className={`${rule} ${row}`}>
          <Skeleton className="size-9 shrink-0 squircle rounded-sm" />
          <span className="flex h-[41px] flex-1 flex-col justify-center gap-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3.5 w-4/5" />
          </span>
        </li>
      ))}
    </ul>
  );
}

// A tile of repos under a heading. Ranked rows carry their place. While the repos are on their way, the tile holds
// placeholder rows, or the rows it had, and says so. The heading is a live region, so a screen reader hears each answer.
export function RepoList({
  heading,
  repos,
  ranked = false,
  busy = false,
  more,
  onOpen,
}: {
  heading: ReactNode;
  repos: ReadonlyArray<ListedRepo> | undefined;
  ranked?: boolean;
  busy?: boolean;
  more?: (() => void) | undefined;
  onOpen: OpenListed;
}) {
  return (
    <Tile
      aria-busy={busy || undefined}
      className="flex min-w-0 flex-col px-5 pt-5 pb-4 sm:gap-1 sm:px-7 sm:pt-6 sm:pb-5"
    >
      <h2 className="pb-2.5 font-display text-xl leading-7 font-semibold tracking-snug">
        <span role="status">{heading}</span>
      </h2>
      {repos === undefined ? (
        <PlaceholderRows />
      ) : (
        <ol className="flex flex-col">
          {repos.map((repo, index) => (
            <RepoRow key={repo.id} repo={repo} place={ranked ? index + 1 : undefined} onOpen={onOpen} />
          ))}
        </ol>
      )}
      {more !== undefined && (
        <button
          type="button"
          onClick={more}
          className={`${textLinkClass} mt-3 self-start font-sans text-meta font-semibold`}
        >
          show more
        </button>
      )}
    </Tile>
  );
}
