import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge only knows Tailwind's default scales, so it learns the theme's own names here. A test keeps this list
// equal to theme.css.
export const themeScales = {
  text: ["label", "sm", "meta", "base", "lg", "title", "xl", "name", "2xl", "3xl", "4xl", "display", "hero"],
  spacing: ["gap", "tile-sm", "tile-top", "tile", "tile-lg"],
  radius: ["xs", "sm", "md", "tile", "full", "item"],
  leading: ["sm", "base", "lg", "xl"],
  tracking: ["tight", "snug", "caps"],
  font: ["display", "sans", "mono"],
  container: ["page", "narrow"],
  shadow: ["panel", "dock"],
  ease: ["out"],
  animate: ["settle", "skeleton"],
};

const merge = extendTailwindMerge({ extend: { theme: themeScales } });

export const cn = (...inputs: ClassValue[]) => merge(clsx(inputs));
