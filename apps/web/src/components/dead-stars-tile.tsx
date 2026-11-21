import { Chip, formatStars, type OpenResult, RepoIcon, Tile } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import type { MouseEvent } from "react";
import type { DeadStars } from "../lib/dead-stars.ts";
import { toResult } from "../lib/present.ts";
import type { Params } from "../lib/search-params.ts";
import { formatCount, type Whose } from "../lib/whose.ts";

const plainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

const headline = ({ count }: DeadStars, whose: Whose) =>
  `${formatCount(count)} of ${whose.own ? "your" : `@${whose.login}'s`} stars ${count === 1 ? "is" : "are"} archived`;

// The archived repos an account starred: how many, the most starred few, and a chip that filters the library to them.
export function DeadStarsTile({
  dead,
  whose,
  at,
  search,
  onOpen,
}: {
  dead: DeadStars;
  whose: Whose;
  at: number;
  search: Params;
  onOpen: OpenResult;
}) {
  return (
    <Tile className="flex flex-col gap-6 pt-tile-top pr-6 pb-6 pl-tile-lg lg:col-span-2 lg:flex-row lg:items-center lg:gap-10">
      <div className="flex shrink-0 flex-col gap-1 lg:w-72">
        <h2 className="font-display text-2xl font-semibold tracking-snug">dead stars</h2>
        <p className="font-sans text-base text-muted-foreground">{headline(dead, whose)}</p>
      </div>
      <ol aria-label="most starred" className="flex min-w-0 flex-1 flex-col gap-4 sm:flex-row sm:flex-wrap sm:gap-x-8">
        {dead.top.map((entry) => {
          const result = toResult(entry, at, { search, flagUnread: false });
          return (
            <li key={entry.id} className="min-w-0">
              <a
                href={result.href}
                onClick={(event) => {
                  if (!plainClick(event)) return;
                  event.preventDefault();
                  onOpen(result, event.currentTarget);
                }}
                className="flex min-w-0 items-center gap-3 rounded-sm"
              >
                <RepoIcon visual={result.visual} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-display text-lg leading-6 font-semibold tracking-snug">
                    {entry.name}
                  </span>
                  <span className="truncate font-sans text-meta font-medium text-muted-foreground">
                    {entry.owner}
                    {entry.stars !== null && ` · ${formatStars(entry.stars)} stars`}
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ol>
      <Chip
        className="self-start lg:self-center"
        render={<Link to="." search={(previous) => ({ ...previous, archived: search.archived ? undefined : true })} />}
      >
        {search.archived ? "show every star" : `see all ${formatCount(dead.count)}`}
      </Chip>
    </Tile>
  );
}
