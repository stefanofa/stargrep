import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="skeleton"
      className={cn("block rounded-full bg-(--skullet-base) motion-safe:animate-skeleton", className)}
      {...props}
    />
  );
}
