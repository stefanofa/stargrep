import { Button, type OpenResult, ResultList, Skeleton, type Sort, type View } from "@stargrep/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LibraryEntry } from "../lib/library-collection.ts";
import { libraryFilter } from "../lib/library-filter.ts";
import { libraryOrder } from "../lib/order.ts";
import { monthOf, toResult } from "../lib/present.ts";
import type { Params } from "../lib/search-params.ts";
import type { Arriving } from "../lib/search-state.ts";
import { starCount } from "../lib/whose.ts";

const pageSize = 48;

const columns = 4;

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

export function LibraryPlaceholder({ view }: { view: View }) {
  return (
    <section className="flex flex-col gap-gap pt-3">
      <div aria-hidden className="flex items-baseline gap-2.5 pl-1.5">
        <span className="font-display text-2xl font-semibold tracking-snug">
          <Skeleton className="inline-block h-6 w-48 align-middle" />
        </span>
      </div>
      <ResultList view={view} results={[]} pending={8} enter="tile-in" />
    </section>
  );
}

export function LibraryView({
  entries,
  at,
  view,
  sort,
  search,
  arriving,
  onOpen,
}: {
  entries: ReadonlyArray<LibraryEntry>;
  at: number;
  view: View;
  sort: Sort;
  search: Params;
  arriving: Arriving | undefined;
  onOpen: OpenResult;
}) {
  const language = search.lang;
  const archived = search.archived === true;
  const [shown, setShown] = useState(pageSize);
  const seen = useRef(new Set<string>());
  const visible = useMemo(
    () => entries.filter(libraryFilter(language, archived, search.starred, search.topic)).toSorted(libraryOrder(sort)),
    [entries, language, archived, search.starred, search.topic, sort],
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
