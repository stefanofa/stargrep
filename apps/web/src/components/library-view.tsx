import {
  Button,
  LanguageBar,
  type LanguageShare,
  Mascot,
  type OpenResult,
  type Result,
  ResultItem,
  type Sort,
  SortMenu,
  SyncProgress,
  Tile,
  type View,
  ViewToggle,
} from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import type { LibraryEntry } from "../lib/library-collection.ts";
import { formatCount, monthOf, stars, toResult } from "../lib/present.ts";

const pageSize = 48;

const order: Record<Sort, (a: LibraryEntry, b: LibraryEntry) => number> = {
  starred: (a, b) => b.starredAt.localeCompare(a.starredAt),
  stars: (a, b) => (b.stars ?? -1) - (a.stars ?? -1),
  pushed: (a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""),
};

export const languageShares = (entries: ReadonlyArray<LibraryEntry>): ReadonlyArray<LanguageShare> => {
  const counts = new Map<string, number>();
  for (const entry of entries)
    if (entry.language !== null) counts.set(entry.language, (counts.get(entry.language) ?? 0) + 1);
  return Array.from(counts, ([name, count]) => ({ name, share: count / entries.length })).toSorted(
    (a, b) => b.share - a.share,
  );
};

export function ResultGrid({
  view,
  results,
  onOpen,
}: {
  view: View;
  results: ReadonlyArray<Result>;
  onOpen: OpenResult;
}) {
  return (
    <div
      className={`${view === "list" ? "view-list" : "view-tiles"} grid grid-cols-1 gap-gap sm:grid-cols-2 lg:grid-cols-4 list:flex list:flex-col list:gap-3`}
    >
      <ol className="contents list:flex list:flex-col list:gap-3">
        {results.map((result) => (
          <li key={`${result.owner}/${result.name}`} className="animate-tile-in">
            <ResultItem result={result} onOpen={onOpen} />
          </li>
        ))}
      </ol>
    </div>
  );
}

export interface Syncing {
  readonly total: number;
  readonly timeLeft: string;
}

function CountTile({ count, syncing, synced }: { count: number; syncing: Syncing | undefined; synced: ReactNode }) {
  return (
    <Tile
      variant="highlight"
      className="relative flex min-h-[236px] flex-col justify-between gap-6 overflow-hidden pt-tile-top pb-6 pl-tile-lg"
    >
      <div className="relative z-10 flex flex-col">
        <p className="font-display text-[88px] leading-[88px] font-semibold tracking-tight sm:text-hero sm:leading-[120px]">
          {formatCount(count)}
        </p>
        <p className="font-display text-2xl font-semibold">stars</p>
      </div>
      <div className="relative z-10">
        {syncing === undefined ? (
          synced
        ) : (
          <SyncProgress done={count} total={syncing.total} timeLeft={syncing.timeLeft} />
        )}
      </div>
      <div className="absolute top-1/2 right-6 flex size-[200px] -translate-y-1/2 items-center justify-center rounded-full bg-[#ffffff] max-sm:hidden">
        <Mascot mood="delighted" size={150} />
      </div>
    </Tile>
  );
}

function LanguagesTile({ shares, language }: { shares: ReadonlyArray<LanguageShare>; language: string | undefined }) {
  const chip = (active: boolean) =>
    `flex h-9 items-center rounded-full px-4 font-sans text-meta font-medium transition-colors duration-120 ${
      active ? "bg-accent font-semibold text-ink" : "bg-accent-soft text-foreground hover:bg-accent-soft/70"
    }`;
  return (
    <Tile className="flex flex-col justify-between gap-6 pt-tile-top pb-6 pl-tile-lg">
      <h2 className="font-display text-2xl font-semibold tracking-snug">languages</h2>
      {shares.length > 0 && <LanguageBar languages={shares} />}
      <nav aria-label="Filter by language" className="flex flex-wrap gap-2">
        <Link
          to="/search"
          search={(previous) => ({ ...previous, lang: undefined })}
          className={chip(language === undefined)}
        >
          All
        </Link>
        {shares.slice(0, 3).map((share) => (
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

export function LibraryView({
  entries,
  at,
  view,
  onViewChange,
  sort,
  onSortChange,
  language,
  syncing,
  synced,
  onOpen,
}: {
  entries: ReadonlyArray<LibraryEntry>;
  at: number;
  view: View;
  onViewChange: (view: View) => void;
  sort: Sort;
  onSortChange: (sort: Sort) => void;
  language: string | undefined;
  syncing: Syncing | undefined;
  synced: ReactNode;
  onOpen: OpenResult;
}) {
  const [shown, setShown] = useState(pageSize);
  const shares = useMemo(() => languageShares(entries), [entries]);
  const visible = useMemo(
    () => entries.filter((entry) => language === undefined || entry.language === language).toSorted(order[sort]),
    [entries, language, sort],
  );
  const page = visible.slice(0, shown);
  const groups =
    sort === "starred"
      ? Map.groupBy(page, (entry) => monthOf(entry.starredAt))
      : new Map([[language === undefined ? "all stars" : language.toLowerCase(), page]]);
  const counts = Map.groupBy(visible, (entry) => monthOf(entry.starredAt));
  const controls = (
    <div className="flex items-center gap-[10px]">
      <SortMenu value={sort} onValueChange={onSortChange} />
      <ViewToggle value={view} onValueChange={onViewChange} />
    </div>
  );
  return (
    <>
      <div className="grid gap-gap lg:grid-cols-2">
        <CountTile count={entries.length} syncing={syncing} synced={synced} />
        <LanguagesTile shares={shares} language={language} />
      </div>
      {Array.from(groups, ([heading, members], index) => (
        <section key={heading} aria-label={heading} className="flex flex-col gap-gap pt-3">
          <div className="flex flex-wrap items-center justify-between gap-3 pl-1.5">
            <h2 className="flex items-baseline gap-2.5">
              <span className="font-display text-2xl font-semibold tracking-snug">{heading}</span>
              <span className="font-sans text-base text-muted-foreground">
                {stars(sort === "starred" ? (counts.get(heading)?.length ?? 0) : visible.length)}
              </span>
            </h2>
            {index === 0 && controls}
          </div>
          <ResultGrid view={view} results={members.map((entry) => toResult(entry, [], at))} onOpen={onOpen} />
        </section>
      ))}
      {visible.length > shown && (
        <Button variant="ghost" size="lg" className="self-center" onClick={() => setShown((count) => count + pageSize)}>
          Show more
        </Button>
      )}
    </>
  );
}
