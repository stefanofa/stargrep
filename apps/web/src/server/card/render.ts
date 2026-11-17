import { initWasm, Resvg } from "@resvg/resvg-wasm";
import type { ReactNode } from "react";
import satori, { init as initSatori } from "satori/standalone";
import { cardSize } from "./card.tsx";

type Wasm = WebAssembly.Module | ArrayBuffer | Uint8Array<ArrayBuffer>;
type Font = ArrayBuffer;

// The Worker imports the two WebAssembly modules and the fonts its own way and a Bun script reads them from disk, so
// each passes them in. Satori reads WOFF but not WOFF2, so the fonts come from @fontsource rather than packages/ui.
export interface CardAssets {
  readonly layoutWasm: Wasm;
  readonly resvgWasm: Wasm;
  readonly fonts: { readonly fredoka600: Font; readonly inter500: Font; readonly inter600: Font };
}

// Satori draws the text as paths, so resvg needs no fonts of its own.
export const cardRenderer = (assets: CardAssets) => {
  let ready: Promise<void> | undefined;
  const fonts = [
    { name: "Fredoka", data: assets.fonts.fredoka600, weight: 600 as const },
    { name: "Inter", data: assets.fonts.inter500, weight: 500 as const },
    { name: "Inter", data: assets.fonts.inter600, weight: 600 as const },
  ];
  return async (card: ReactNode): Promise<Uint8Array> => {
    ready ??= Promise.all([initSatori(assets.layoutWasm), initWasm(assets.resvgWasm)]).then(() => undefined);
    await ready;
    const svg = await satori(card, { ...cardSize, fonts });
    const renderer = new Resvg(svg, { fitTo: { mode: "width", value: cardSize.width } });
    try {
      const image = renderer.render();
      try {
        return image.asPng();
      } finally {
        image.free();
      }
    } finally {
      renderer.free();
    }
  };
};
