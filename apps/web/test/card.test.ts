import { expect, test } from "bun:test";
import { siteCard, siteCardPath } from "../scripts/og-image.ts";
import { themeColor } from "../scripts/theme.ts";
import { cardSize } from "../src/server/card/card.tsx";
import { palette } from "../src/server/card/palette.ts";

const tokens: Record<keyof typeof palette, string> = {
  background: "background",
  card: "card",
  ink: "ink",
  inkSecondary: "ink-secondary",
  accentSoft: "accent-soft",
  highlight: "highlight",
  highlightEdge: "highlight-edge",
};

test("the cards paint the light theme's colors", () => {
  for (const [key, token] of Object.entries(tokens))
    expect([key, palette[key as keyof typeof palette]]).toEqual([key, themeColor(token).light.toLowerCase()]);
});

// The PNG header names the size at fixed offsets, so a preview's declared og:image size can be checked without a decoder.
const sizeOf = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

test("public/og.png is the site card the current layout draws, at the size the head declares", async () => {
  const drawn = await siteCard();
  expect(sizeOf(drawn)).toEqual(cardSize);
  const committed = await Bun.file(siteCardPath).bytes();
  expect(Buffer.compare(Buffer.from(committed), Buffer.from(drawn)), "run bun run --cwd apps/web og").toBe(0);
});
