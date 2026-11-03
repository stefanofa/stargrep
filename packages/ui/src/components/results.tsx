import { type ReactNode, useId } from "react";
import { cn } from "../lib/cn.ts";
import { Mascot, type MascotMotion, type Mood } from "../mascot.tsx";
import { NetworkAvatars, type Person } from "./avatar.tsx";
import { Badge } from "./badge.tsx";
import { StarIcon } from "./icons.tsx";
import { Skeleton } from "./skeleton.tsx";
import type { View } from "./view-toggle.tsx";

export type Activity =
  | { readonly state: "alive"; readonly label: string }
  | { readonly state: "quiet"; readonly label: string }
  | { readonly state: "archived" }
  | { readonly state: "deprecated" };

export type Match = readonly [start: number, end: number];

export type Result = {
  readonly owner: string;
  readonly name: string;
  readonly href: string;
  readonly reason: string;
  readonly matches: ReadonlyArray<Match>;
  readonly activity: Activity;
  readonly stars: number;
  readonly starred: string;
  readonly network: ReadonlyArray<Person>;
};

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export const formatStars = (stars: number) => compact.format(stars).toLowerCase();

export function highlight(text: string, matches: ReadonlyArray<Match>): ReactNode[] {
  const ranges = matches
    .map(([start, end]) => [Math.max(0, start), Math.min(text.length, end)] as const)
    .filter(([start, end]) => start < end)
    .toSorted((a, b) => a[0] - b[0]);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) parts.push(text.slice(cursor, from));
    parts.push(<mark key={from}>{text.slice(from, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export const activityLabel = (activity: Activity) => ("label" in activity ? activity.label : activity.state);

const retired = (activity: Activity) => activity.state === "archived" || activity.state === "deprecated";

const footerCell = "border-t-[1.5px] border-foreground/12 pt-[14px]";

const layouts = {
  hero: {
    article:
      "butter sm:grid-cols-[auto_auto_1fr] sm:px-[30px] sm:pt-[26px] sm:pb-6 sm:[grid-template-areas:'head_head_stars'_'reason_reason_reason'_'alive_starred_network']",
    name: "sm:text-3xl sm:leading-[40px]",
    owner: "text-base leading-gap text-secondary-foreground",
    reason: "text-foreground sm:text-lg",
    stars: "sm:gap-1.5",
    starIcon: "sm:size-[26px]",
    starCount: "sm:text-[40px] sm:leading-[44px]",
    starred: cn(footerCell, "sm:flex sm:items-center sm:gap-1 sm:pr-gap"),
    starredText: "text-[14px] leading-sm font-medium text-secondary-foreground",
    starredLabel: "",
    alive: "",
    dot: "sm:size-[9px]",
    network: "",
  },
  tile: {
    article:
      "sm:grid-cols-[1fr_auto] sm:grid-rows-[auto_auto_auto_1fr_auto] sm:gap-y-3 sm:pt-6 sm:pr-[22px] sm:pb-[22px] sm:pl-6 sm:[grid-template-areas:'head_head'_'reason_reason'_'network_network'_'stars_starred'_'alive_alive']",
    name: "",
    owner: "",
    reason: "",
    stars: "sm:mt-2.5 sm:self-end sm:justify-self-start",
    starIcon: "",
    starCount: "",
    starred: "sm:mt-2.5 sm:flex sm:flex-col sm:items-end sm:gap-0.5 sm:self-end sm:pb-0.5",
    starredText: "text-sm leading-4 font-medium text-foreground",
    starredLabel: "text-label leading-[13px] font-semibold tracking-caps text-muted-foreground uppercase",
    alive: "sm:gap-1.5 sm:border-muted sm:pt-3 sm:pr-0 sm:text-sm sm:leading-4 sm:text-muted-foreground",
    dot: "",
    network: "sm:self-start sm:justify-start sm:border-0 sm:pt-0 sm:text-sm sm:leading-4",
  },
};

const listText = "list:text-sm list:leading-4 list:text-muted-foreground";
const listCell = "list:self-center list:border-0 list:pt-0 list:pr-0 list:mt-0";

export function ResultItem({ result, hero = false }: { result: Result; hero?: boolean }) {
  const layout = hero ? layouts.hero : layouts.tile;
  const dim = retired(result.activity);
  const networkCell = cn(
    "[grid-area:network] flex items-center justify-end",
    footerCell,
    layout.network,
    "list:justify-start",
    listCell,
  );
  return (
    <article
      className={cn(
        "relative grid h-full grid-cols-[1fr_auto] grid-rows-[auto_1fr_auto] gap-y-[14px] rounded-tile bg-card px-[22px] pt-[22px] pb-gap text-foreground [grid-template-areas:'head_stars'_'reason_reason'_'alive_network']",
        dim && "border-[1.5px] border-border",
        layout.article,
        "list:gap-y-2 list:rounded-md list:px-tile list:py-gap list:sm:grid-cols-[180px_100px_190px_1fr] list:sm:grid-rows-none list:sm:[grid-template-areas:'head_head_head_head'_'reason_reason_reason_reason'_'alive_stars_starred_network']",
      )}
    >
      <header className="[grid-area:head] grid grid-cols-[1fr_auto] items-start gap-x-2 gap-y-0.5 list:flex list:items-baseline list:gap-x-1.5">
        <h3
          className={cn(
            "col-start-1 row-start-1 font-display text-[26px] leading-[30px] font-semibold tracking-snug",
            dim && "text-muted-foreground",
            layout.name,
            "list:text-[22px] list:leading-tile",
          )}
        >
          <a href={result.href} className="rounded-sm after:absolute after:inset-0 after:rounded-[inherit]">
            {result.name}
          </a>
        </h3>
        <p
          className={cn(
            "col-start-1 row-start-2 font-sans text-[14px] leading-sm font-medium text-muted-foreground",
            layout.owner,
            "list:order-first list:text-[16px] list:leading-tile list:after:content-['_/']",
          )}
        >
          {result.owner}
        </p>
        {dim && <Badge className="col-start-2 row-start-1 list:ml-1 list:self-center">{result.activity.state}</Badge>}
      </header>
      <p
        className={cn(
          "[grid-area:reason] font-sans text-base text-secondary-foreground",
          layout.reason,
          "list:text-base",
        )}
      >
        {highlight(result.reason, result.matches)}
      </p>
      <dl className="contents font-sans">
        <div
          className={cn(
            "[grid-area:stars] flex items-center gap-[5px] self-start justify-self-end",
            dim && "text-muted-foreground",
            layout.stars,
            "list:mt-0 list:self-center list:justify-self-start",
          )}
        >
          <dt className="sr-only">stars</dt>
          <dd className="flex items-center gap-[inherit]">
            <StarIcon className={cn("size-5", dim && "opacity-45", layout.starIcon, "list:size-[15px]")} />
            <span
              className={cn(
                "font-display text-2xl leading-[34px] font-semibold tracking-tight",
                layout.starCount,
                "list:text-lg list:leading-gap list:tracking-normal",
              )}
            >
              {formatStars(result.stars)}
            </span>
          </dd>
        </div>
        <div
          className={cn(
            "[grid-area:starred] hidden",
            layout.starred,
            "list:flex list:flex-row list:items-center list:gap-1 list:pb-0",
            listCell,
          )}
        >
          <dt
            className={cn(layout.starredText, layout.starredLabel, "list:tracking-normal list:normal-case", listText)}
          >
            starred
          </dt>
          <dd className={cn(layout.starredText, listText)}>{result.starred}</dd>
        </div>
        <div
          className={cn(
            "[grid-area:alive] flex items-center gap-[7px] pr-gap text-[14px] leading-sm font-medium text-secondary-foreground",
            footerCell,
            layout.alive,
            listText,
            listCell,
          )}
        >
          <dt className="sr-only">activity</dt>
          <dd className="flex items-center gap-[inherit]">
            <span
              aria-hidden
              className={cn(
                "size-2 shrink-0 rounded-full",
                result.activity.state === "alive" ? "bg-success" : "bg-muted-foreground",
                dim && "opacity-45",
                layout.dot,
                "list:size-2",
              )}
            />
            {activityLabel(result.activity)}
          </dd>
        </div>
        {result.network.length > 0 && (
          <div className={networkCell}>
            <dt className="sr-only">network</dt>
            <dd className="relative z-10">
              <NetworkAvatars
                people={result.network}
                className={cn("text-[14px] leading-sm text-secondary-foreground", layout.network, listText)}
              />
            </dd>
          </div>
        )}
      </dl>
      {result.network.length === 0 && <span aria-hidden className={networkCell} />}
    </article>
  );
}

export function ResultSkeleton({ hero = false }: { hero?: boolean }) {
  return (
    <div
      data-slot="result-skeleton"
      className={cn(
        "flex h-full min-h-[240px] flex-col gap-3 rounded-tile bg-card p-6 list:min-h-0 list:rounded-md list:px-tile list:py-gap",
        hero && "sm:px-[30px] sm:pt-[30px]",
      )}
    >
      <div className="flex justify-between">
        <Skeleton className={cn("h-6 w-[118px]", hero && "sm:h-8 sm:w-[168px]")} />
        {hero && <Skeleton className="h-9 w-28 max-sm:hidden list:hidden" />}
      </div>
      <Skeleton className="h-3 w-[84px] list:hidden" />
      <Skeleton className="mt-3 h-3 w-full" />
      <Skeleton className="h-3 w-[88%] list:hidden" />
      <Skeleton className="h-3 w-[52%] list:hidden" />
      <div className="mt-auto flex items-end justify-between border-t-[1.5px] border-muted pt-3 list:border-0 list:pt-0">
        <Skeleton className="h-3 w-[116px]" />
        <Skeleton className="h-3 w-[72px]" />
      </div>
    </div>
  );
}

function Sparkle({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={cn("absolute fill-highlight list:hidden", className)}>
      <path d="M10 1c.6 4.6 3.4 7.4 9 9-5.6 1.6-8.4 4.4-9 9-.6-4.6-3.4-7.4-9-9 5.6-1.6 8.4-4.4 9-9z" />
    </svg>
  );
}

export function ResultsSummary({
  heading,
  detail,
  controls,
  mood,
  motion,
}: {
  heading: ReactNode;
  detail: ReactNode;
  controls?: ReactNode;
  mood?: Mood;
  motion?: MascotMotion | undefined;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="relative flex flex-col justify-between gap-6 rounded-tile sm:min-h-[240px] bg-card px-[30px] pt-tile pb-6 sm:col-span-2 list:min-h-0 list:flex-row list:items-center list:bg-transparent list:p-0 list:pt-2 list:pl-tile"
    >
      <div className="relative z-10 flex flex-col gap-1.5 list:flex-row list:items-baseline list:gap-3">
        <h2
          id={headingId}
          className="font-display text-3xl leading-[40px] font-semibold tracking-tight sm:text-display sm:leading-[56px] list:text-2xl list:leading-[36px] list:tracking-snug"
        >
          {heading}
        </h2>
        <div className="font-sans text-[16px] leading-base text-muted-foreground list:text-base">{detail}</div>
      </div>
      {controls && <div className="relative z-10 flex flex-wrap items-center gap-gap list:gap-[10px]">{controls}</div>}
      {mood && (
        <>
          <Mascot
            mood={mood}
            motion={motion}
            size={200}
            className="absolute top-2.5 right-[26px] rotate-[10deg] max-sm:size-[112px] list:hidden"
          />
          <Sparkle className="top-10 right-[236px] size-5 max-sm:hidden" />
          <Sparkle className="top-[26px] right-[30px] size-[13px] max-sm:hidden" />
        </>
      )}
    </section>
  );
}

export function Results({
  view,
  results,
  summary,
  pending = 0,
}: {
  view: View;
  results: ReadonlyArray<Result>;
  summary?: ReactNode;
  pending?: number;
}) {
  return (
    <div
      className={cn(
        view === "list" ? "view-list" : "view-tiles",
        "grid grid-cols-1 gap-gap sm:grid-cols-2 lg:grid-cols-4 list:flex list:flex-col list:gap-3",
      )}
    >
      {summary}
      <ol aria-busy={pending > 0} aria-label="Results" className="contents list:flex list:flex-col list:gap-3">
        {results.map((result, index) => (
          <li
            key={`${result.owner}/${result.name}`}
            className={cn("animate-tile-in", index === 0 && "sm:col-span-2")}
            style={{ animationDelay: `${index * 30}ms` }}
          >
            <ResultItem result={result} hero={index === 0} />
          </li>
        ))}
        {Array.from({ length: pending }, (_, index) => {
          const position = results.length + index;
          return (
            <li key={`pending-${position}`} aria-hidden className={cn(position === 0 && "sm:col-span-2")}>
              <ResultSkeleton hero={position === 0} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}
