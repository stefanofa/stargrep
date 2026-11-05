import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

const tileVariants = cva("relative squircle rounded-tile p-tile text-foreground", {
  variants: {
    variant: {
      default: "bg-card",
      highlight: "butter",
      quiet: "border-[1.5px] border-border bg-transparent",
      archived: "bg-card text-muted-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export type TileVariant = NonNullable<VariantProps<typeof tileVariants>["variant"]>;

export function Tile({ className, variant, ...props }: ComponentProps<"div"> & VariantProps<typeof tileVariants>) {
  return <div data-slot="tile" className={cn(tileVariants({ variant }), className)} {...props} />;
}

export { tileVariants };
