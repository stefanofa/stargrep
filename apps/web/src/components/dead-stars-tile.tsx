import { Chip, cn, formatStars, type OpenResult, Tile } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import type { DeadStars } from "../lib/dead-stars.ts";
import { toResult } from "../lib/present.ts";
import type { Params } from "../lib/search-params.ts";
import { formatCount, type Whose } from "../lib/whose.ts";
import { RepoLine } from "./repo-line.tsx";

const headline = ({ count }: DeadStars, whose: Whose) =>
  `${formatCount(count)} of ${whose.own ? "your" : `@${whose.login}'s`} stars ${count === 1 ? "is" : "are"} archived`;

// The archived repos an account starred: how many, the most starred few, and a chip that filters the library to them.
// It is a wide tile under the summary tiles, or one tile of the discover row on someone else's stars.
export function DeadStarsTile({
  dead,
  whose,
  at,
  search,
  onOpen,
  narrow = false,
}: {
  dead: DeadStars;
  whose: Whose;
  at: number;
  search: Params;
  onOpen: OpenResult;
  narrow?: boolean;
}) {
  return (
    <Tile
      className={cn(
        "flex flex-col gap-6 pt-tile-top pr-6 pb-6 pl-tile-lg",
        narrow ? "min-w-0 lg:flex-1 lg:pl-6" : "lg:col-span-2 lg:flex-row lg:items-center lg:gap-10",
      )}
    >
      <div className={cn("flex shrink-0 flex-col gap-1", !narrow && "lg:w-72")}>
        <h2 className="font-display text-2xl font-semibold tracking-snug">dead stars</h2>
        <p className="font-sans text-base text-muted-foreground">{headline(dead, whose)}</p>
      </div>
      <ol
        aria-label="most starred"
        className={cn("flex min-w-0 flex-1 flex-col gap-4", !narrow && "sm:flex-row sm:flex-wrap sm:gap-x-8")}
      >
        {dead.top.map((entry) => (
          <li key={entry.id} className="min-w-0">
            <RepoLine
              result={toResult(entry, at, { search, flagUnread: false })}
              line={entry.stars === null ? entry.owner : `${entry.owner} · ${formatStars(entry.stars)} stars`}
              onOpen={onOpen}
            />
          </li>
        ))}
      </ol>
      <Chip
        className={cn("self-start", !narrow && "lg:self-center")}
        render={<Link to="." search={(previous) => ({ ...previous, archived: search.archived ? undefined : true })} />}
      >
        {search.archived ? "show every star" : `see all ${formatCount(dead.count)}`}
      </Chip>
    </Tile>
  );
}
