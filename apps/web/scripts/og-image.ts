// Writes public/og.png, the link preview image of every page without its own card: bun run og
import { defaultPublicConfig } from "@stargrep/api/public-config";
import { createElement } from "react";
import { SiteCard } from "../src/server/card/card.tsx";
import { cardRenderer } from "../src/server/card/render.ts";

const file = (specifier: string) => Bun.file(Bun.resolveSync(specifier, import.meta.dir));

export const siteCardPath = new URL("../public/og.png", import.meta.url);

export const siteCard = async () => {
  const render = cardRenderer({
    layoutWasm: await file("satori/layout.wasm").bytes(),
    resvgWasm: await file("@resvg/resvg-wasm/index_bg.wasm").bytes(),
    fonts: {
      fredoka600: await file("@fontsource/fredoka/files/fredoka-latin-600-normal.woff").arrayBuffer(),
      inter500: await file("@fontsource/inter/files/inter-latin-500-normal.woff").arrayBuffer(),
      inter600: await file("@fontsource/inter/files/inter-latin-600-normal.woff").arrayBuffer(),
    },
  });
  return render(
    createElement(SiteCard, { query: defaultPublicConfig.demoQuery, examples: defaultPublicConfig.examples }),
  );
};

if (import.meta.main) await Bun.write(siteCardPath, await siteCard());
