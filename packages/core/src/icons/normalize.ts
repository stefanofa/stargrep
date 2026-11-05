import { type IconPlate, type IconSource, maxIconSize } from "@stargrep/db";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { decodeBmp, icoEntries } from "./ico.ts";
import { animated, declaredSize, type RasterFormat, sniff } from "./image-format.ts";
import { aspectOf, fit, plateOf, type Rgba, visible } from "./pixels.ts";

export type { RasterFormat } from "./image-format.ts";
export type { Rgba } from "./pixels.ts";

export interface Codecs {
  readonly decode: (format: RasterFormat, bytes: Uint8Array) => Promise<Rgba>;
  readonly renderSvg: (svg: string, longSide: number) => Promise<Rgba>;
  readonly encodeWebp: (image: Rgba) => Promise<Uint8Array>;
}

class IconRejected extends Schema.TaggedError<IconRejected, { readonly brand: unique symbol }>()("IconRejected", {
  reason: Schema.Literals([
    "unsupported",
    "animated",
    "unsafe-svg",
    "undecodable",
    "too-small",
    "oversized",
    "blank",
    "not-square",
  ]),
}) {}

export type Rejection = IconRejected["reason"];

export type Normalized = Data.TaggedEnum<{
  Accepted: { readonly webp: Uint8Array; readonly plate: IconPlate; readonly size: number };
  Rejected: { readonly reason: Rejection };
}>;
export const Normalized = Data.taggedEnum<Normalized>();

const svgRenderSide = 512;
const minRasterSide = 16;
const maxDecodeSide = 2048;
const minCoverage = 0.02;
const maxAspect = { vector: 1.5, raster: 1.25 };
const maxRasterSide: Record<IconSource, number> = {
  "repo-file": maxDecodeSide,
  "readme-image": 1024,
  homepage: maxDecodeSide,
};

const unsafeSvg = /<script|<foreignObject|<!ENTITY|(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/)/i;

const reject = (reason: Rejection) => Effect.fail(new IconRejected({ reason }));

export const make = (codecs: Codecs) => {
  const decodeRaster = (format: RasterFormat, bytes: Uint8Array, maxSide: number) => {
    const declared = declaredSize(format, bytes);
    if (declared === null) return reject("undecodable");
    if (Math.min(declared.width, declared.height) < minRasterSide) return reject("too-small");
    if (Math.max(declared.width, declared.height) > maxSide) return reject("oversized");
    return Effect.tryPromise({
      try: () => codecs.decode(format, bytes),
      catch: () => new IconRejected({ reason: "undecodable" }),
    });
  };

  const decodeIco = Effect.fn("IconNormalizer.decodeIco")(function* (bytes: Uint8Array) {
    const largest = icoEntries(bytes).toSorted((a, b) => b.width - a.width)[0];
    if (largest === undefined) return yield* reject("undecodable");
    if (largest.width < minRasterSide) return yield* reject("too-small");
    if (sniff(largest.bytes) === "png") return yield* decodeRaster("png", largest.bytes, maxDecodeSide);
    const bitmap = decodeBmp(largest.bytes);
    return bitmap === null ? yield* reject("undecodable") : bitmap;
  });

  const renderSvg = (bytes: Uint8Array) => {
    const svg = new TextDecoder().decode(bytes);
    if (unsafeSvg.test(svg)) return reject("unsafe-svg");
    return Effect.tryPromise({
      try: () => codecs.renderSvg(svg, svgRenderSide),
      catch: () => new IconRejected({ reason: "undecodable" }),
    });
  };

  const decode = (bytes: Uint8Array, source: IconSource) => {
    const format = sniff(bytes);
    if (format === "gif" || format === "avif" || format === "unknown") return reject("unsupported");
    if (animated(format, bytes)) return reject("animated");
    const image =
      format === "svg"
        ? renderSvg(bytes)
        : format === "ico"
          ? decodeIco(bytes)
          : decodeRaster(format, bytes, maxRasterSide[source]);
    return Effect.map(image, (decoded) => ({ decoded, vector: format === "svg" }));
  };

  const normalize = Effect.fn("IconNormalizer.normalize")(
    function* (bytes: Uint8Array, source: IconSource) {
      const { decoded, vector } = yield* decode(bytes, source);
      const { coverage, box } = visible(decoded);
      if (box === null || coverage < minCoverage) return yield* reject("blank");
      // A favicon often draws a wide glyph on a square canvas, and a logo often pads a square mark inside a wide one.
      // A banner is wide both ways, so either shape being square enough is enough.
      const limit = vector ? maxAspect.vector : maxAspect.raster;
      if (aspectOf(decoded) > limit && aspectOf(box) > limit) return yield* reject("not-square");
      const icon = fit(decoded, box, maxIconSize);
      const webp = yield* Effect.tryPromise(() => codecs.encodeWebp(icon)).pipe(Effect.orDie);
      return Normalized.Accepted({ webp, plate: plateOf(icon), size: icon.width });
    },
    Effect.catchTags({ IconRejected: ({ reason }) => Effect.succeed(Normalized.Rejected({ reason })) }),
  );

  return { normalize };
};

export class IconNormalizer extends Context.Service<
  IconNormalizer,
  {
    readonly normalize: (bytes: Uint8Array, source: IconSource) => Effect.Effect<Normalized>;
  }
>()("@stargrep/core/icons/normalize/IconNormalizer") {}

export const layer = (codecs: Codecs) => Layer.succeed(IconNormalizer, IconNormalizer.of(make(codecs)));
