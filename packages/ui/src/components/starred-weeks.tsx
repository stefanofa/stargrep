import { cn } from "../lib/cn.ts";

const steps = ["bg-muted", "bg-accent-soft", "bg-accent/60", "bg-accent", "bg-accent-strong", "bg-foreground"] as const;

const step = (count: number, max: number) => {
  if (count === 0 || max === 0) return 0;
  if (count === max) return steps.length - 1;
  return Math.min(steps.length - 2, Math.ceil((count / max) * (steps.length - 2)));
};

export type StarredDay = {
  readonly date: string;
  readonly stars: number;
};

export type StarredWeek = {
  readonly start: string;
  readonly days: ReadonlyArray<StarredDay>;
};

export function StarredWeeks({
  weeks,
  summary,
  className,
}: {
  weeks: ReadonlyArray<StarredWeek>;
  summary: string;
  className?: string;
}) {
  const max = Math.max(0, ...weeks.flatMap((week) => week.days.map((day) => day.stars)));
  return (
    <figure className={cn("flex flex-col gap-2", className)}>
      <div
        role="img"
        aria-label={summary}
        className="grid grid-flow-col grid-rows-7 gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}
      >
        {weeks.flatMap((week) =>
          week.days.map((day) => (
            <span key={day.date} className={cn("aspect-square rounded-[3px]", steps[step(day.stars, max)])} />
          )),
        )}
      </div>
      <table className="sr-only">
        <caption>Stars per week</caption>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">Stars</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.start}>
              <td>{week.start}</td>
              <td>{week.days.reduce((sum, day) => sum + day.stars, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
