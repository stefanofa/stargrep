import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-sans font-semibold whitespace-nowrap transition-[color,background-color] duration-120 select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/85",
        secondary: "bg-accent-soft text-foreground hover:bg-accent-soft/70",
        ghost: "bg-card text-foreground hover:bg-muted",
        accent: "bg-accent text-ink hover:bg-accent/85",
        muted: "bg-muted text-foreground hover:bg-border",
        bare: "text-accent-strong hover:bg-accent/25",
      },
      size: {
        default: "h-9 px-4 text-[14px]",
        lg: "h-11 px-5 text-base",
        icon: "size-10",
        xs: "size-5 [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
