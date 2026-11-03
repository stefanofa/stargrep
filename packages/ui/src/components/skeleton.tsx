import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("rounded-full bg-muted", className)} {...props} />;
}
