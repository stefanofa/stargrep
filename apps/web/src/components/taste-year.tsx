import { AxisTicks, ChartTip, cn, dayFill, Tile, TipAction, useMarks } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import {
  busiest,
  busiestWeekday,
  dayName,
  dayOf,
  starsOf,
  type TasteWeek,
  type TasteWords,
  weekSpan,
  weekStars,
  weekTicks,
} from "../lib/taste.ts";
import { formatCount, starCount } from "../lib/whose.ts";

const days = 7;
const said = (stars: number) => (stars === 0 ? "no stars" : starCount(stars));

// The last 52 weeks a day at a time, 26 on phones, as GitHub draws a year, with the busiest week beside them. Each day
// opens the stars of that day.
export function YearTile({
  login,
  weeks,
  lastYear,
  words,
}: {
  login: string;
  weeks: ReadonlyArray<TasteWeek>;
  lastYear: number;
  words: TasteWords;
}) {
  const weekday = busiestWeekday(weeks);
  const wide = busiest(weeks, weekStars);
  const phone = weeks.slice(-26);
  const phoneBusiest = busiest(phone, weekStars);
  return (
    <Tile className="flex flex-col gap-3 px-5 pt-5 pb-4.5 sm:gap-4 sm:px-7 sm:py-6">
      <div className="flex items-baseline justify-between gap-3 sm:justify-start">
        <h2 className="font-display text-[22px] leading-6.5 font-semibold tracking-snug sm:text-[26px] sm:leading-7.5">
          {words.year}
        </h2>
        <p className="font-sans text-sm text-muted-foreground sm:text-meta">
          <span className="sm:hidden">{`last ${phone.length} weeks`}</span>
          <span className="max-sm:hidden">
            {`${formatCount(lastYear)} ${lastYear === 1 ? "star" : "stars"} in 52 weeks`}
            {weekday !== undefined && ` · most on ${weekday}`}
          </span>
        </p>
      </div>
      <div className="flex items-start gap-10 max-sm:hidden">
        <WeekGrid login={login} weeks={weeks} className="min-w-0 flex-1 lg:w-181.25 lg:flex-none" />
        {wide !== undefined && (
          <div className="flex flex-col gap-1 border-l-[1.5px] border-muted pl-7">
            <p className="font-sans text-sm text-muted-foreground">busiest week</p>
            <p className="font-display text-2xl font-semibold">{starCount(weekStars(wide))}</p>
            <p className="font-sans text-meta leading-5 text-secondary-foreground">{weekSpan(wide)}</p>
          </div>
        )}
      </div>
      <WeekGrid login={login} weeks={phone} className="sm:hidden" />
      {phoneBusiest !== undefined && (
        <p className="font-sans text-meta leading-5 text-secondary-foreground sm:hidden">
          {"busiest week: "}
          <span className="font-semibold text-foreground">{starCount(weekStars(phoneBusiest))}</span>
          {`, ${weekSpan(phoneBusiest)}`}
        </p>
      )}
    </Tile>
  );
}

function WeekGrid({ login, weeks, className }: { login: string; weeks: ReadonlyArray<TasteWeek>; className?: string }) {
  const last = weeks.at(-1);
  const today = (weeks.length - 1) * days + Math.max(0, (last?.days.length ?? 1) - 1);
  const { active, mark } = useMarks(weeks.length * days, { rows: days, start: today });
  const max = Math.max(0, ...weeks.flatMap((week) => week.days));
  const column = active === undefined ? 0 : Math.floor(active / days);
  const week = weeks[column];
  const stars = active === undefined ? undefined : week?.days[active % days];
  const date = week === undefined || active === undefined ? "" : dayOf(week.start, active % days);
  return (
    <figure className={cn("flex flex-col gap-2", className)}>
      <div className="relative">
        <ol
          aria-label={`stars per day from ${dayName(weeks[0]?.start ?? "", true)}. each day opens that day's stars`}
          className="grid grid-flow-col grid-rows-7"
          style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}
        >
          {weeks.flatMap((week, column) =>
            week.days.map((count, row) => {
              const index = column * days + row;
              const date = dayOf(week.start, row);
              const props = {
                ...mark(index),
                "aria-label": `${dayName(date, true)}: ${said(count)}`,
                className: "block rounded-[4px] p-[1.5px]",
              };
              const square = (
                <span
                  aria-hidden
                  className={cn(
                    "block aspect-square rounded-[3px]",
                    dayFill(count, max),
                    active === index && "outline-[1.5px] outline-offset-1 outline-foreground",
                  )}
                />
              );
              return (
                <li key={date}>
                  {count === 0 ? (
                    <span role="img" {...props}>
                      {square}
                    </span>
                  ) : (
                    <Link {...starsOf(login, { starred: date })} {...props}>
                      {square}
                    </Link>
                  )}
                </li>
              );
            }),
          )}
        </ol>
        {stars !== undefined && active !== undefined && (
          <ChartTip from={column / weeks.length} to={(column + 1) / weeks.length} className="bottom-[calc(100%+6px)]">
            <span className="font-semibold">{`${dayName(date)} · ${said(stars)}`}</span>
            {stars > 0 && <TipAction>open in stars →</TipAction>}
          </ChartTip>
        )}
      </div>
      <AxisTicks ticks={weekTicks(weeks)} anchor="start" />
    </figure>
  );
}
