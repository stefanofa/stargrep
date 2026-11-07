import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const chipVariants = cva(
  "relative flex h-9 items-center rounded-full px-4 font-sans text-meta font-medium text-foreground transition-[color,background-color,scale] duration-120 after:absolute after:inset-x-0 after:-inset-y-1 motion-safe:active:scale-[0.96]",
  {
    variants: {
      tone: {
        soft: "bg-accent-soft hover:bg-accent/30",
        card: "bg-card hover:bg-muted",
      },
      active: {
        true: "bg-accent font-semibold text-ink hover:bg-accent",
        false: "",
      },
    },
    defaultVariants: { tone: "soft", active: false },
  },
);

// A pill that searches or filters. It renders a button, or a router link through `render`.
export function Chip({
  className,
  tone,
  active,
  render,
  ...props
}: useRender.ComponentProps<"button"> & VariantProps<typeof chipVariants>) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">({ className: cn(chipVariants({ tone, active }), className) }, props),
    render,
    state: { slot: "chip" },
  });
}
