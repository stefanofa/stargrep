import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const badgeVariants = cva("inline-flex w-fit shrink-0 items-center rounded-full font-sans whitespace-nowrap", {
  variants: {
    variant: {
      label: "h-6 bg-muted px-[9px] text-label font-bold text-secondary-foreground uppercase",
      chip: "h-9 gap-1.5 bg-accent-soft pr-2 pl-3.5 text-[14px] leading-sm font-medium text-foreground",
    },
  },
  defaultVariants: {
    variant: "label",
  },
});

export function Badge({
  className,
  variant,
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">({ className: cn(badgeVariants({ variant }), className) }, props),
    render,
    state: { slot: "badge", variant },
  });
}
