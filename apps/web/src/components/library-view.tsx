import {
  Button,
  Chip,
  cn,
  Digits,
  LanguageBar,
  type LanguageShare,
  type OpenResult,
  Pip,
  type PipPose,
  ResultList,
  Skeleton,
  type Sort,
  Tile,
  type View,
} from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { dead, deadStars } from "../lib/dead-stars.ts";
import { languageShares } from "../lib/languages.ts";
import type { LibraryEntry } from "../lib/library-collection.ts";
import { libraryOrder } from "../lib/order.ts";
import { monthOf, toResult } from "../lib/present.ts";
import type { Params } from "../lib/search-params.ts";
import type { Arriving } from "../lib/search-state.ts";
import { formatCount, starCount, type Whose } from "../lib/whose.ts";
import { DeadStarsTile } from "./dead-stars-tile.tsx";

const pageSize = 48;

const columns = 4;

// A visitor's page already has the butter tile in its hero, so their count tile stays white.
function CountTile({
  count,
  arriving,
  pose,
  butter,
}: {
  count: number | undefined;
  arriving: Arriving | undefined;
  pose: PipPose;
  butter: boolean;
}) {
  return (
    <Tile
      variant={butter ? "highlight" : "default"}
      className="relative flex min-h-[148px] items-center justify-between gap-4 overflow-hidden pt-6 pr-5 pb-6 pl-6 sm:min-h-[236px] sm:pt-tile-top sm:pl-tile-lg"
    >
      <div className="relative z-10 flex flex-col">
        <p className="font-display text-[64px] leading-[64px] font-semibold tracking-tight sm:text-hero sm:leading-[120px]">
          {count === undefined ? (
            <Skeleton className="inline-block h-[0.7em] w-[2.4em] align-middle" />
          ) : (
            <Digits>{formatCount(count)}</Digits>
          )}
        </p>
        {/* Phones wrap "of 27 stars, still arriving" to two lines, so the caption keeps two lines once the import is
            done and the library below never moves. */}
        <p className="font-display text-lg leading-6 font-semibold max-sm:min-h-[2lh] sm:text-2xl">
          {arriving === undefined
            ? "stars"
            : arriving.total === null
              ? "stars, still arriving"
              : `of ${formatCount(arriving.total)} stars, still arriving`}
        </p>
      </div>
      <div
        className={cn(
          "flex size-[104px] shrink-0 items-center justify-center rounded-full sm:size-[200px]",
          butter ? "bg-plate" : "bg-accent-soft",
        )}
      >
        <Pip pose={pose} size={150} className="max-sm:size-[78px]" />
      </div>
    </Tile>
  );
}

const waitingChips = ["w-[92px]", "w-[118px]", "w-[78px]"];

function LanguagesTile({
  shares,
  language,
}: {
  shares: ReadonlyArray<LanguageShare> | undefined;
  language: string | undefined;
}) {
  return (
    <Tile className="flex flex-col justify-between gap-6 pt-tile-top pb-6 pl-tile-lg">
      <h2 className="font-display text-2xl font-semibold tracking-snug">languages</h2>
      {shares === undefined ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-3" />
          <Skeleton className="h-4 w-56" />
        </div>
      ) : (
        shares.length > 0 && <LanguageBar languages={shares} />
      )}
      <nav aria-label="Filter by language" className="flex flex-wrap gap-2">
        <Chip
          active={language === undefined}
          render={
            <Link
              to="."
              search={(previous) => ({ ...previous, lang: undefined })}
              activeOptions={{ explicitUndefined: true }}
            />
          }
        >
          all
        </Chip>
        {shares === undefined && waitingChips.map((width) => <Skeleton key={width} className={`h-9 ${width}`} />)}
        {(shares ?? []).slice(0, 3).map((share) => (
          <Chip
            key={share.name}
            active={language === share.name}
            render={<Link to="." search={(previous) => ({ ...previous, lang: share.name })} />}
          >
            {share.name} {Math.round(share.share * 100)}%
          </Chip>
        ))}
      </nav>
    </Tile>
  );
}

function MonthHeading({ heading, size, arriving }: { heading: string; size: number; arriving: boolean }) {
  return (
    <h2 className="flex items-baseline gap-2.5 pl-1.5">
      <span className="font-display text-2xl font-semibold tracking-snug">{heading}</span>
      <span className="font-sans text-base text-muted-foreground tabular-nums">
        {starCount(size)}
        {/* Phones leave "so far" to the status line, so the heading keeps one line when the import finishes. */}
        {arriving && <span className="max-sm:hidden"> so far</span>}
      </span>
    </h2>
  );
}

// The one heading of a library sorted by something other than the starred date.
const groupHeading = (language: string | undefined, archived: boolean) => {
  const scope = language === undefined ? "all stars" : language.toLowerCase();
  if (!archived) return scope;
  return language === undefined ? "archived" : `archived ${scope}`;
};

export function LibraryPlaceholder({
  view,
  arriving,
  butter,
}: {
  view: View;
  arriving?: Arriving | undefined;
  butter: boolean;
}) {
  return (
    <>
      <div aria-busy className="grid gap-gap lg:grid-cols-2">
        <CountTile count={undefined} arriving={arriving} pose="idle" butter={butter} />
        <LanguagesTile shares={undefined} language={undefined} />
      </div>
      <section className="flex flex-col gap-gap pt-3">
        <div aria-hidden className="flex items-baseline gap-2.5 pl-1.5">
          <span className="font-display text-2xl font-semibold tracking-snug">
            <Skeleton className="inline-block h-6 w-48 align-middle" />
          </span>
        </div>
        <ResultList view={view} results={[]} pending={8} enter="tile-in" />
      </section>
    </>
  );
}

export function LibraryView({
  entries,
  at,
  view,
  sort,
  search,
  whose,
  arriving,
  pose,
  butter,
  onOpen,
  aside,
}: {
  entries: ReadonlyArray<LibraryEntry>;
  at: number;
  view: View;
  sort: Sort;
  search: Params;
  whose: Whose;
  arriving: Arriving | undefined;
  pose: PipPose;
  butter: boolean;
  onOpen: OpenResult;
  // A section between the summary tiles and the months, such as what's new to a signed-in viewer.
  aside?: ReactNode;
}) {
  const language = search.lang;
  const archived = search.archived === true;
  const [shown, setShown] = useState(pageSize);
  const seen = useRef(new Set<string>());
  const shares = useMemo(() => languageShares(entries), [entries]);
  const graveyard = useMemo(() => deadStars(entries), [entries]);
  const visible = useMemo(
    () =>
      entries
        .filter((entry) => (language === undefined || entry.language === language) && (!archived || dead(entry)))
        .toSorted(libraryOrder(sort)),
    [entries, language, archived, sort],
  );
  const page = visible.slice(0, shown);
  const byMonth = sort === "starred" || sort === "best";
  const groups = byMonth
    ? Map.groupBy(page, (entry) => monthOf(entry.starredAt))
    : new Map([[groupHeading(language, archived), page]]);
  const counts = Map.groupBy(visible, (entry) => monthOf(entry.starredAt));
  const last = Array.from(groups.keys()).at(-1);
  const remaining = arriving?.total == null ? columns : Math.max(0, arriving.total - entries.length);
  useEffect(() => {
    for (const entry of page) seen.current.add(`${entry.owner}/${entry.name}`);
  });
  return (
    <>
      <div className="grid gap-gap lg:grid-cols-2">
        <CountTile count={entries.length} arriving={arriving} pose={pose} butter={butter} />
        <LanguagesTile shares={shares} language={language} />
        {/* The tile stays while its filter is on, so its chip can take the filter back off. */}
        {(graveyard.count > 0 || archived) && (
          <DeadStarsTile dead={graveyard} whose={whose} at={at} search={search} onOpen={onOpen} />
        )}
      </div>
      {aside}
      {Array.from(groups, ([heading, members]) => {
        const pending =
          arriving !== undefined && heading === last && visible.length <= shown
            ? Math.min(remaining, columns - (members.length % columns))
            : 0;
        const size = byMonth ? (counts.get(heading)?.length ?? 0) : visible.length;
        return (
          <section key={heading} aria-label={heading} className="flex flex-col gap-gap pt-3">
            <MonthHeading heading={heading} size={size} arriving={arriving !== undefined} />
            <ResultList
              view={view}
              results={members.map((entry) => toResult(entry, at, { search, flagUnread: false }))}
              pending={pending}
              enter="tile-in"
              entering={(key) => !seen.current.has(key)}
              onOpen={onOpen}
            />
          </section>
        );
      })}
      {visible.length > shown && (
        <Button variant="ghost" size="lg" className="self-center" onClick={() => setShown((count) => count + pageSize)}>
          show more
        </Button>
      )}
    </>
  );
}
