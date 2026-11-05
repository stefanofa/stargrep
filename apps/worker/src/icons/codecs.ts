/// <reference path="./wasm-imports.d.ts" />
import jpegDecoder from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm?module";
import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode";
import pngDecoder from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm?module";
import decodePng, { init as initPng } from "@jsquash/png/decode";
import webpDecoder from "@jsquash/webp/codec/dec/webp_dec.wasm?module";
import webpEncoder from "@jsquash/webp/codec/enc/webp_enc_simd.wasm?module";
import decodeWebp, { init as initWebpDecoder } from "@jsquash/webp/decode";
import encodeWebp, { init as initWebpEncoder } from "@jsquash/webp/encode";
import { initWasm as initResvg, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm?module";
import type { Normalize } from "@stargrep/core/icons";

const webpOptions = { quality: 85, alpha_quality: 90, method: 4 };

let ready: Promise<void> | undefined;

// The layers are rebuilt for every invocation, so the codecs instantiate once per isolate, on the first icon.
const init = () => {
  ready ??= Promise.all([
    initJpeg(jpegDecoder),
    initPng(pngDecoder),
    initWebpDecoder(webpDecoder),
    initWebpEncoder(webpEncoder),
    initResvg(resvgWasm),
  ]).then(() => undefined);
  return ready;
};

const decoders = {
  png: (bytes: Uint8Array<ArrayBuffer>) => decodePng(bytes.buffer),
  jpeg: (bytes: Uint8Array<ArrayBuffer>) => decodeJpeg(bytes.buffer),
  webp: (bytes: Uint8Array<ArrayBuffer>) => decodeWebp(bytes.buffer),
} satisfies Record<Normalize.RasterFormat, (bytes: Uint8Array<ArrayBuffer>) => Promise<Normalize.Rgba>>;

export const codecs: Normalize.Codecs = {
  decode: async (format, bytes) => {
    await init();
    // An ICO entry is a view into the whole file, and the decoders read the view's entire buffer.
    return decoders[format](bytes.slice());
  },
  renderSvg: async (svg, longSide) => {
    await init();
    const probe = new Resvg(svg);
    const fitTo =
      probe.width >= probe.height
        ? { mode: "width" as const, value: longSide }
        : { mode: "height" as const, value: longSide };
    probe.free();
    const renderer = new Resvg(svg, { fitTo, font: { loadSystemFonts: false } });
    try {
      const rendered = renderer.render();
      try {
        return { width: rendered.width, height: rendered.height, data: rendered.pixels };
      } finally {
        rendered.free();
      }
    } finally {
      renderer.free();
    }
  },
  encodeWebp: async (image) => {
    await init();
    const data = {
      data: new Uint8ClampedArray(image.data),
      width: image.width,
      height: image.height,
      colorSpace: "srgb" as const,
    };
    return new Uint8Array(await encodeWebp(data, webpOptions));
  },
};
