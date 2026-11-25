import { AxisTicks, ChartTip, cn, Tile, TipAction, useMarks } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { busiest, monthName, monthTicks, starsOf, type TasteMonth, type Tick } from "../lib/taste.ts";
import { formatCount, starCount } from "../lib/whose.ts";
import { textLinkClass } from "./external-text-link.tsx";

// How many months each screen shows until someone asks for them all.
const recent = { wide: 24, phone: 12 } as const;

// Stars per month, the latest 24 on wide screens and 12 on phones, or every month since the first star. The busiest
// month is accent-strong and the current one, still running, is ink. Each bar opens those stars.
export function MonthsTile({ login, months, all }: { login: string; months: ReadonlyArray<TasteMonth>; all: boolean }) {
  const views = (["wide", "phone"] as const).map((screen) => {
    const shown = all ? months : months.slice(-recent[screen]);
    return { screen, shown, more: !all && shown.length < months.length };
  });
  return (
    <Tile className="flex min-w-0 flex-col gap-3.5 px-5 pt-5 pb-4.5 sm:gap-4.5 sm:px-7 sm:pt-6 sm:pb-5.5 lg:w-195 lg:shrink-0">
      {views.map(({ screen, shown, more }) => (
        <div key={screen} className={cn("contents", screen === "wide" ? "max-sm:hidden" : "sm:hidden")}>
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="font-display text-[22px] leading-6.5 font-semibold tracking-snug sm:text-[26px] sm:leading-7.5">
              stars per month
            </h2>
            <p className="font-sans text-sm text-muted-foreground">
              <Summary shown={shown} wide={screen === "wide"} all={all} />
              {(more || all) && months.length > recent[screen] && (
                <>
                  {" · "}
                  <Link
                    to="/@{$login}/taste"
                    params={{ login }}
                    search={all ? {} : { months: "all" }}
                    replace
                    resetScroll={false}
                    className={cn(textLinkClass, "font-medium")}
                  >
                    {all ? `last ${recent[screen]}` : "see all"}
                  </Link>
                </>
              )}
            </p>
          </div>
          {/* Another span of months is another chart, whose tab stop starts again at its latest month. */}
          <MonthBars
            key={shown.length}
            login={login}
            months={shown}
            ticks={screen === "phone" && !all ? phoneTicks(shown) : monthTicks(shown)}
          />
        </div>
      ))}
    </Tile>
  );
}

// A phone names the ends of its year by month alone, and says between them what a bar does.
const phoneTicks = (months: ReadonlyArray<TasteMonth>): ReadonlyArray<Tick> => [
  { at: 0, label: monthName(months[0]?.month ?? "", true) },
  { at: 0.5, label: "tap a bar to open that month" },
  { at: 1, label: monthName(months.at(-1)?.month ?? "", true) },
];

function Summary({ shown, wide, all }: { shown: ReadonlyArray<TasteMonth>; wide: boolean; all: boolean }) {
  const span = all ? `since ${monthName(shown[0]?.month ?? "")}` : `${wide ? "last " : ""}${shown.length} months`;
  const peak = busiest(shown, (month) => month.stars);
  if (!wide || peak === undefined) return span;
  return (
    <>
      {`${span} · busiest `}
      <span className="font-semibold text-accent-strong">{`${monthName(peak.month)}, ${formatCount(peak.stars)}`}</span>
    </>
  );
}

function MonthBars({
  login,
  months,
  ticks,
}: {
  login: string;
  months: ReadonlyArray<TasteMonth>;
  ticks: ReadonlyArray<Tick>;
}) {
  const { active, mark } = useMarks(months.length);
  const count = months.length;
  const max = Math.max(1, ...months.map((month) => month.stars));
  const peak = busiest(months, (month) => month.stars);
  const now = months.at(-1);
  // Bars thin out as the months add up, and so do their rounded tops.
  const radius = count > 60 ? 1 : count > 30 ? 3 : 6;
  const shown = active === undefined ? undefined : months[active];
  const when = (month: TasteMonth) => `${monthName(month.month)}${month === now ? " so far" : ""}`;
  const stars = (month: TasteMonth) => (month.stars === 0 ? "no stars" : starCount(month.stars));
  return (
    <figure className="flex flex-col gap-3.5 sm:gap-4.5">
      <div className="relative h-27.5 border-b-[1.5px] border-muted sm:h-42.5">
        <ol
          aria-label={`stars per month, ${monthName(months[0]?.month ?? "")} to ${monthName(now?.month ?? "")}. each bar opens that month's stars`}
          className="flex h-full"
        >
          {months.map((month, index) => {
            const props = {
              ...mark(index),
              "aria-label": `${when(month)}: ${stars(month)}`,
              className: "flex h-full flex-col justify-end rounded-xs",
            };
            return (
              <li key={month.month} className="min-w-0 flex-1">
                {month.stars === 0 ? (
                  <span role="img" {...props} />
                ) : (
                  <Link {...starsOf(login, { starred: month.month })} {...props}>
                    <span
                      aria-hidden
                      className={cn(
                        "block w-[min(22px,72%)] transition-opacity duration-120",
                        month === now ? "bg-foreground" : month === peak ? "bg-accent-strong" : "bg-accent",
                        active !== undefined && active !== index && "opacity-45",
                      )}
                      style={{
                        height: `max(2px, ${(month.stars / max) * 88}%)`,
                        // Flush with the plot's edges, as bars spaced between would sit, while each hit area stays a
                        // full column.
                        marginLeft: `calc((100% - min(22px, 72%)) * ${count === 1 ? 0 : index / (count - 1)})`,
                        borderTopLeftRadius: radius,
                        borderTopRightRadius: radius,
                      }}
                    />
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
        {shown !== undefined && active !== undefined && (
          <ChartTip from={active / count} to={(active + 1) / count} className="top-1">
            <span className="font-semibold">{`${when(shown)} · ${stars(shown)}`}</span>
            {shown.stars > 0 && <TipAction>open in stars →</TipAction>}
          </ChartTip>
        )}
      </div>
      <AxisTicks ticks={ticks} />
    </figure>
  );
}
