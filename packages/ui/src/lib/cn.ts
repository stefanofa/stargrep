import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["label", "sm", "meta", "base", "lg", "xl", "name", "2xl", "3xl", "4xl", "display", "hero"],
      spacing: ["gap", "tile-sm", "tile-top", "tile", "tile-lg"],
      radius: ["sm", "md", "tile", "full"],
      leading: ["sm", "base", "lg", "xl"],
      tracking: ["tight", "snug", "caps"],
      font: ["display", "sans", "mono"],
      container: ["page", "narrow"],
      shadow: ["panel", "dock"],
      ease: ["out"],
      animate: ["tile-in", "fade-in", "skeleton"],
    },
  },
});

export const cn = (...inputs: ClassValue[]) => merge(clsx(inputs));
