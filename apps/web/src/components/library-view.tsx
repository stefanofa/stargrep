import {
  Button,
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
import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "../lib/library-collection.ts";
import { libraryOrder } from "../lib/order.ts";
import { formatCount, monthOf, stars, toResult } from "../lib/present.ts";

const pageSize = 48;

export const languageShares = (entries: ReadonlyArray<LibraryEntry>): ReadonlyArray<LanguageShare> => {
  const counts = new Map<string, number>();
  for (const entry of entries)
    if (entry.language !== null) counts.set(entry.language, (counts.get(entry.language) ?? 0) + 1);
  return Array.from(counts, ([name, count]) => ({ name, share: count / entries.length })).toSorted(
    (a, b) => b.share - a.share,
  );
};

const columns = 4;

export interface Arriving {
  readonly total: number | null;
}

function CountTile({
  count,
  arriving,
  pose,
}: {
  count: number | undefined;
  arriving: Arriving | undefined;
  pose: PipPose;
}) {
  return (
    <Tile
      variant="highlight"
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
        <p className="font-display text-lg leading-6 font-semibold sm:text-2xl">
          {arriving === undefined
            ? "stars"
            : arriving.total === null
              ? "stars, still arriving"
              : `of ${formatCount(arriving.total)} stars, still arriving`}
        </p>
      </div>
      <div className="flex size-[104px] shrink-0 items-center justify-center rounded-full bg-plate sm:size-[200px]">
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
  const chip = (active: boolean) =>
    `relative after:absolute after:inset-x-0 after:-inset-y-1 flex h-9 items-center rounded-full px-4 font-sans text-meta font-medium transition-[color,background-color,scale] duration-120 motion-safe:active:scale-[0.96] ${
      active ? "bg-accent font-semibold text-ink" : "bg-accent-soft text-foreground hover:bg-accent-soft/70"
    }`;
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
        <Link
          to="/search"
          search={(previous) => ({ ...previous, lang: undefined })}
          className={chip(language === undefined)}
        >
          All
        </Link>
        {shares === undefined && waitingChips.map((width) => <Skeleton key={width} className={`h-9 ${width}`} />)}
        {(shares ?? []).slice(0, 3).map((share) => (
          <Link
            key={share.name}
            to="/search"
            search={(previous) => ({ ...previous, lang: share.name })}
            className={chip(language === share.name)}
          >
            {share.name} {Math.round(share.share * 100)}%
          </Link>
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
        {stars(size)}
        {arriving && " so far"}
      </span>
    </h2>
  );
}

export function LibraryPlaceholder({ view }: { view: View }) {
  return (
    <>
      <div aria-busy className="grid gap-gap lg:grid-cols-2">
        <CountTile count={undefined} arriving={undefined} pose="idle" />
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
  language,
  arriving,
  pose,
  onOpen,
}: {
  entries: ReadonlyArray<LibraryEntry>;
  at: number;
  view: View;
  sort: Sort;
  language: string | undefined;
  arriving: Arriving | undefined;
  pose: PipPose;
  onOpen: OpenResult;
}) {
  const [shown, setShown] = useState(pageSize);
  const seen = useRef(new Set<string>());
  const shares = useMemo(() => languageShares(entries), [entries]);
  const visible = useMemo(
    () => entries.filter((entry) => language === undefined || entry.language === language).toSorted(libraryOrder(sort)),
    [entries, language, sort],
  );
  const page = visible.slice(0, shown);
  const byMonth = sort === "starred" || sort === "best";
  const groups = byMonth
    ? Map.groupBy(page, (entry) => monthOf(entry.starredAt))
    : new Map([[language === undefined ? "all stars" : language.toLowerCase(), page]]);
  const counts = Map.groupBy(visible, (entry) => monthOf(entry.starredAt));
  const last = Array.from(groups.keys()).at(-1);
  const remaining = arriving?.total == null ? columns : Math.max(0, arriving.total - entries.length);
  useEffect(() => {
    for (const entry of page) seen.current.add(`${entry.owner}/${entry.name}`);
  });
  return (
    <>
      <div className="grid gap-gap lg:grid-cols-2">
        <CountTile count={entries.length} arriving={arriving} pose={pose} />
        <LanguagesTile shares={shares} language={language} />
      </div>
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
              results={members.map((entry) => toResult(entry, at, { flagUnread: false }))}
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
          Show more
        </Button>
      )}
    </>
  );
}
