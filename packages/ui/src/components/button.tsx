import { Button as ButtonPrimitive } from "@base-ui/react/button";
import type { VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";
import { buttonVariants } from "./button-variants.ts";

export function Button({
  className,
  variant,
  size,
  static: isStatic,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, static: isStatic }), className)}
      {...props}
    />
  );
}
