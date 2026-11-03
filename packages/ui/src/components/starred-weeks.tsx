import { cn } from "../lib/cn.ts";

const steps = ["bg-muted", "bg-accent-soft", "bg-accent/60", "bg-accent", "bg-accent-strong", "bg-foreground"] as const;

const step = (count: number, max: number) => {
  if (count === 0 || max === 0) return 0;
  if (count === max) return steps.length - 1;
  return Math.min(steps.length - 2, Math.ceil((count / max) * (steps.length - 2)));
};

export function StarredWeeks({
  weeks,
  summary,
  className,
}: {
  weeks: ReadonlyArray<ReadonlyArray<number>>;
  summary: string;
  className?: string;
}) {
  const max = Math.max(0, ...weeks.flat());
  return (
    <figure className={cn("flex flex-col gap-2", className)}>
      <div
        role="img"
        aria-label={summary}
        className="grid grid-flow-col grid-rows-7 gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}
      >
        {weeks.flatMap((days, week) =>
          days.map((stars, day) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the grid position is the identity
            <span key={`${week}-${day}`} className={cn("aspect-square rounded-[3px]", steps[step(stars, max)])} />
          )),
        )}
      </div>
      <table className="sr-only">
        <caption>Stars per week</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Stars</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((days, week) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: weeks are positional
            <tr key={week}>
              <td>{week + 1}</td>
              <td>{days.reduce((sum, stars) => sum + stars, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
