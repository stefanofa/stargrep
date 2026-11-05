import { type MouseEvent, type ReactNode, useId } from "react";
import { Skeleton as Measured } from "skullet/react";
import { cn } from "../lib/cn.ts";
import { NetworkAvatars, type Person } from "./avatar.tsx";
import { Badge } from "./badge.tsx";
import { StarIcon } from "./icons.tsx";
import { RepoIcon, type RepoVisual } from "./repo-icon.tsx";
import { tileVariants } from "./tile.tsx";
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
  readonly stars: number | null;
  readonly starred: string;
  readonly network: ReadonlyArray<Person>;
  readonly visual: RepoVisual;
  readonly language: string | null;
  readonly unread: boolean;
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

const heroText = {
  name: "tiles:sm:text-[34px] tiles:sm:leading-[40px]",
  reason: "tiles:text-foreground tiles:sm:text-lg",
};

const listText = "list:text-sm list:text-muted-foreground";
const listCell = "list:self-center list:border-0 list:pt-0 list:pr-0 list:mt-0";

export type OpenResult = (result: Result, opener: HTMLAnchorElement) => void;

const plainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

function UnreadChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-full bg-muted pr-2.5 pl-2 font-sans text-[12px] leading-4 font-semibold whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      <svg aria-hidden viewBox="0 0 12 12" className="size-3" fill="none">
        <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" />
      </svg>
      not read yet
    </span>
  );
}

export function ResultItem({
  result,
  hero = false,
  onOpen,
}: {
  result: Result;
  hero?: boolean;
  onOpen?: OpenResult | undefined;
}) {
  const dim = retired(result.activity);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onOpen || !plainClick(event)) return;
    event.preventDefault();
    onOpen(result, event.currentTarget);
  };
  return (
    <article
      className={cn(
        tileVariants(),
        hero && "tiles:butter",
        "grid h-full grid-cols-[1fr_auto] grid-rows-[auto_auto_auto_1fr_auto] gap-y-3 pt-6 pr-tile-sm pb-tile-sm pl-6 [grid-template-areas:'head_head'_'reason_reason'_'network_network'_'stars_starred'_'alive_alive']",
        "list:grid-cols-[auto_1fr] list:grid-rows-none list:gap-x-4 list:gap-y-2 list:sm:gap-x-0 list:rounded-md list:py-gap list:pr-tile list:pl-[74px] list:[grid-template-areas:'head_head'_'reason_reason'_'alive_stars'] list:sm:grid-cols-[180px_100px_190px_1fr] list:sm:[grid-template-areas:'head_head_head_head'_'reason_reason_reason_reason'_'alive_stars_starred_network']",
      )}
    >
      <header className="[grid-area:head] flex min-w-0 items-center gap-3 list:items-baseline">
        <span className="shrink-0 list:absolute list:top-gap list:left-[22px]">
          <RepoIcon visual={result.visual} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 list:flex-row list:flex-wrap list:items-center list:gap-x-1.5 list:gap-y-0">
          <h3
            className={cn(
              "min-w-0 font-display text-name font-semibold tracking-snug break-words",
              dim && "text-muted-foreground",
              hero && heroText.name,
              "list:text-[22px] list:leading-[28px]",
            )}
          >
            <a
              href={result.href}
              onClick={open}
              className="rounded-sm after:absolute after:inset-0 after:rounded-[inherit]"
            >
              {result.name}
            </a>
          </h3>
          <p
            className={cn(
              "min-w-0 font-sans text-meta font-medium break-words text-muted-foreground",
              "list:order-first list:text-[16px] list:leading-[28px] list:font-normal list:after:content-['_/']",
            )}
          >
            {result.owner}
            {result.language && <span className="list:hidden"> · {result.language}</span>}
          </p>
          {result.unread && <UnreadChip className="hidden list:inline-flex" />}
        </div>
        {dim && <Badge className="self-start list:ml-1 list:self-center">{result.activity.state}</Badge>}
      </header>
      <div className="[grid-area:reason] flex flex-col items-start gap-2">
        {result.unread && <UnreadChip className="list:hidden" />}
        <p
          className={cn(
            "font-sans text-base text-secondary-foreground",
            dim && "text-muted-foreground",
            hero && heroText.reason,
            "list:text-base",
          )}
        >
          {highlight(result.reason, result.matches)}
        </p>
      </div>
      <dl className="contents font-sans">
        {result.stars !== null && (
          <div
            className={cn(
              "[grid-area:stars] mt-2.5 flex items-center gap-[5px] self-end justify-self-start",
              dim && "text-muted-foreground",
              "list:mt-0 list:self-center",
            )}
          >
            <dt className="sr-only">stars</dt>
            <dd className="flex items-center gap-[inherit]">
              <StarIcon className={cn("size-5", dim && "opacity-(--opacity-archived)", "list:size-[15px]")} />
              <span
                className={cn(
                  "font-display text-2xl font-semibold tracking-tight",
                  "list:text-lg list:leading-gap list:tracking-normal",
                )}
              >
                {formatStars(result.stars)}
              </span>
            </dd>
          </div>
        )}
        <div
          className={cn(
            "[grid-area:starred] mt-2.5 flex items-center gap-1 self-end justify-self-end pb-1.5 text-sm font-medium text-muted-foreground",
            "list:hidden list:justify-self-start list:font-normal list:sm:flex",
            listCell,
          )}
        >
          <dt>starred</dt>
          <dd>{result.starred}</dd>
        </div>
        <div
          className={cn(
            "[grid-area:alive] flex items-center gap-1.5 border-t-[1.5px] border-foreground/8 pt-3 text-sm font-medium text-muted-foreground",
            "list:font-normal",
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
                dim && "opacity-(--opacity-archived)",
              )}
            />
            {activityLabel(result.activity)}
          </dd>
        </div>
        {result.network.length > 0 && (
          <div
            className={cn(
              "[grid-area:network] flex items-center justify-start self-start text-sm",
              listCell,
              "list:max-sm:hidden",
            )}
          >
            <dt className="sr-only">network</dt>
            <dd className="relative z-10">
              <NetworkAvatars people={result.network} className={cn("text-meta text-secondary-foreground", listText)} />
            </dd>
          </div>
        )}
      </dl>
    </article>
  );
}

const sample: Result = {
  owner: "ratatui",
  name: "ratatui",
  href: "#",
  reason: "Widgets for charts, gauges, sparklines, and tables. The maintained fork of tui-rs.",
  matches: [],
  activity: { state: "alive", label: "pushed 2 days ago" },
  stars: 16_400,
  starred: "Mar 14, 2025",
  network: [],
  visual: { kind: "monogram", letters: "ra" },
  language: "Rust",
  unread: false,
};

export function ResultPlaceholder({ hero = false }: { hero?: boolean }) {
  return (
    <Measured loading label="Loading a result" className="h-full">
      <ResultItem result={sample} hero={hero} />
    </Measured>
  );
}

export type ResultGroup = {
  readonly key: string;
  readonly heading?: { readonly label: string; readonly detail: string } | undefined;
  readonly results: ReadonlyArray<Result>;
  readonly pending?: number;
};

export function GroupHeading({ id, label, detail }: { id: string; label: string; detail: string }) {
  return (
    <h2 id={id} className="flex items-baseline gap-2 px-2 pt-2">
      <span className="font-sans text-label leading-[14px] font-bold tracking-caps text-secondary-foreground uppercase">
        {label}
      </span>
      <span className="font-sans text-sm font-medium text-muted-foreground">{detail}</span>
    </h2>
  );
}

function Group({
  group,
  heroFirst,
  onOpen,
}: {
  group: ResultGroup;
  heroFirst: boolean;
  onOpen?: OpenResult | undefined;
}) {
  const headingId = useId();
  const pending = group.pending ?? 0;
  return (
    <section aria-labelledby={group.heading ? headingId : undefined} className="flex flex-col gap-3 list:gap-3">
      {group.heading && <GroupHeading id={headingId} {...group.heading} />}
      <ol
        aria-busy={pending > 0}
        aria-label={group.heading ? undefined : "Results"}
        className="grid grid-cols-1 gap-gap sm:grid-cols-2 lg:grid-cols-4 list:flex list:flex-col list:gap-3"
      >
        {group.results.map((result, index) => (
          <li
            key={`${result.owner}/${result.name}`}
            className={cn("animate-tile-in", heroFirst && index === 0 && "sm:col-span-2")}
            style={{ animationDelay: `${index * 30}ms` }}
          >
            <ResultItem result={result} hero={heroFirst && index === 0} onOpen={onOpen} />
          </li>
        ))}
        {Array.from({ length: pending }, (_, index) => {
          const position = group.results.length + index;
          const hero = heroFirst && position === 0;
          return (
            <li key={`pending-${position}`} className={cn(hero && "sm:col-span-2")}>
              <ResultPlaceholder hero={hero} />
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function Results({
  view,
  groups,
  onOpen,
  className,
}: {
  view: View;
  groups: ReadonlyArray<ResultGroup>;
  onOpen?: OpenResult | undefined;
  className?: string;
}) {
  return (
    <div className={cn(view === "list" ? "view-list" : "view-tiles", "flex flex-col gap-6", className)}>
      {groups.map((group, index) => (
        <Group key={group.key} group={group} heroFirst={index === 0} onOpen={onOpen} />
      ))}
    </div>
  );
}
