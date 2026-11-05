import { expect, test } from "bun:test";
import { baseFontsInstalled, fontsCss, fontsCssFile } from "../scripts/fonts.ts";

// GitHub's Ubuntu runners ship Liberation Sans, so in CI a missing font fails the check instead of skipping it.
test.skipIf(!baseFontsInstalled && process.env.CI === undefined)(
  "fonts.css matches what scripts/fonts.ts computes from the font files",
  async () => {
    expect(await fontsCss()).toBe(await Bun.file(fontsCssFile).text());
  },
);
