import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Pip, type PipPose } from "../mark/pip.tsx";
import { ProgressRing } from "./progress-ring.tsx";
import { Tile } from "./tile.tsx";

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
        {ring !== undefined && <ProgressRing progress={ring} on="card" />}
        <Pip pose={pose} size={132} className="sm:size-[150px]" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-center gap-2.5 sm:items-start">
        <h2 className="font-display text-title font-semibold tracking-snug sm:text-2xl">{heading}</h2>
        <p className="max-w-[640px] font-sans text-base text-secondary-foreground sm:text-lg">{body}</p>
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
