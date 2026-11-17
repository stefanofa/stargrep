import { pip } from "@stargrep/ui/mark/pip.gen.ts";
import { starPoints, starStroke } from "@stargrep/ui/mark/star.ts";

// The light theme's tokens from packages/ui/src/theme.css. A card is an image, so it cannot read CSS variables, and
// test/card.test.ts fails when a value here drifts from the theme.
export const palette = {
  background: "#f5f2ff",
  card: "#ffffff",
  ink: "#1e1b2e",
  inkSecondary: "#3a3550",
  accentSoft: "#e9e2ff",
  highlight: "#ffd84d",
  highlightEdge: "#e9b826",
} as const;

// The header mark at rest: the star and its large eyes, as an image a card can place.
const markSvg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`,
  `<polygon points="${starPoints}" fill="${palette.highlightEdge}" stroke="${palette.highlightEdge}" stroke-width="${starStroke.edge}" stroke-linejoin="round"/>`,
  `<polygon points="${starPoints}" fill="${palette.highlight}" stroke="${palette.highlight}" stroke-width="${starStroke.fill}" stroke-linejoin="round"/>`,
  ...pip.eyes.large.map((eye) => `<path d="${eye.d}" fill="${palette.ink}"/>`),
  "</svg>",
].join("");

export const mark = `data:image/svg+xml,${encodeURIComponent(markSvg)}`;
