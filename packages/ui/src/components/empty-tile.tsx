import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Pip, type PipPose } from "../mark/pip.tsx";
import { Tile } from "./tile.tsx";

const circumference = 2 * Math.PI * 78;

function Ring({ progress }: { progress: number }) {
  const length = Math.min(1, Math.max(0, progress)) * circumference;
  return (
    <svg aria-hidden viewBox="0 0 168 168" className="absolute inset-0 size-full" fill="none">
      <circle cx="84" cy="84" r="78" stroke="var(--color-accent-soft)" strokeWidth="7" />
      <circle
        cx="84"
        cy="84"
        r="78"
        transform="rotate(-90 84 84)"
        stroke="var(--color-accent)"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={`${length} ${circumference}`}
        className="transition-[stroke-dasharray] duration-500 ease-out"
      />
    </svg>
  );
}

export function EmptyTile({
  pose,
  ring,
  heading,
  body,
  meta,
  children,
}: {
  pose: PipPose;
  ring?: number | undefined;
  heading: string;
  body: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Tile className="flex flex-col items-center gap-5 px-6 pt-8 pb-7 text-center sm:flex-row sm:gap-10 sm:py-9 sm:pr-12 sm:pl-10 sm:text-left">
      <div
        className={cn(
          "relative flex size-[150px] shrink-0 items-center justify-center rounded-full sm:size-[168px]",
          ring === undefined && "bg-accent-soft",
        )}
      >
        {ring !== undefined && <Ring progress={ring} />}
        <Pip pose={pose} size={132} className="sm:size-[150px]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-center gap-2.5 sm:items-start">
        <h2 className="font-display text-[22px] leading-7 font-semibold tracking-snug sm:text-2xl">{heading}</h2>
        <p className="max-w-[640px] font-sans text-[15px] leading-[22px] text-secondary-foreground sm:text-lg">
          {body}
        </p>
        {meta && (
          <p className="flex items-center gap-2 pt-1.5 font-sans text-sm font-medium text-muted-foreground max-sm:rounded-full max-sm:bg-muted max-sm:px-3.5 max-sm:py-1.5">
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />
            {meta}
          </p>
        )}
        {children}
      </div>
    </Tile>
  );
}

export function RephraseChips({
  phrases,
  onPick,
}: {
  phrases: ReadonlyArray<string>;
  onPick: (phrase: string) => void;
}) {
  if (phrases.length === 0) return null;
  return (
    <ul aria-label="Try other words" className="flex flex-wrap justify-center gap-2 pt-2 sm:justify-start">
      {phrases.map((phrase) => (
        <li key={phrase}>
          <button
            type="button"
            onClick={() => onPick(phrase)}
            className="flex h-9 items-center rounded-full bg-accent-soft px-4 font-sans text-meta font-semibold text-accent-strong transition-colors duration-120 hover:bg-accent/30"
          >
            {phrase}
          </button>
        </li>
      ))}
    </ul>
  );
}
