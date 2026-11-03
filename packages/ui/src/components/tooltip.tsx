import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export function Tooltip({
  content,
  className,
  children,
  ...props
}: Omit<TooltipPrimitive.Trigger.Props, "children"> & { content: ReactNode; children: ReactNode }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        delay={200}
        data-slot="tooltip-trigger"
        className={cn("rounded-full", className)}
        {...props}
      >
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="top" sideOffset={6} className="isolate z-50">
          <TooltipPrimitive.Popup
            data-slot="tooltip-content"
            className="rounded-sm bg-foreground px-3 py-1.5 font-sans text-sm font-medium text-background transition-opacity duration-120 data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
