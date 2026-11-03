import { Progress } from "@base-ui/react/progress";

const count = new Intl.NumberFormat("en");

export function SyncProgress({ done, total, timeLeft }: { done: number; total: number; timeLeft: string }) {
  return (
    <Progress.Root value={done} max={total} aria-label="Syncing stars" className="flex flex-col gap-3">
      <p className="font-display text-[22px] leading-7 font-semibold text-foreground">
        {count.format(done)} <span className="text-muted-foreground">of {count.format(total)}</span>
      </p>
      <Progress.Track className="h-1 w-full max-w-[300px] overflow-hidden rounded-full bg-muted">
        <Progress.Indicator className="h-full rounded-full bg-accent transition-[width] duration-200" />
      </Progress.Track>
      <p className="font-sans text-sm text-muted-foreground">{timeLeft}</p>
    </Progress.Root>
  );
}
