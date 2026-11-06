import type { IconPlate } from "@stargrep/db";

export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

const visibleAlpha = 16;
const minCoverage = 0.02;
// One colour over most of the square, such as a favicon's background left behind when its glyph did not render.
const flat = { minFill: 0.92, maxSpread: 8 };

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// The box around the visible pixels, or the whole canvas when none are, which `blank` then rejects by its coverage.
export const visible = (image: Rgba) => {
  let count = 0;
  let [left, top, right, bottom] = [image.width, image.height, -1, -1];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((image.data[(y * image.width + x) * 4 + 3] ?? 0) < visibleAlpha) continue;
      count++;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  const box: Box =
    right < 0
      ? { x: 0, y: 0, width: image.width, height: image.height }
      : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  return { coverage: count / (image.width * image.height), box };
};

const areaSample = (image: Rgba, x0: number, y0: number, x1: number, y1: number) => {
  let [r, g, b, a, weight] = [0, 0, 0, 0, 0];
  const data = image.data;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    const wy = Math.min(y + 1, y1) - Math.max(y, y0);
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const at = (y * image.width + x) * 4;
      const w = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
      const alpha = (data[at + 3] ?? 0) * w;
      r += (data[at] ?? 0) * alpha;
      g += (data[at + 1] ?? 0) * alpha;
      b += (data[at + 2] ?? 0) * alpha;
      a += alpha;
      weight += w;
    }
  }
  return [r / 255 / weight, g / 255 / weight, b / 255 / weight, a / weight];
};

// Fits the box into a square no larger than the source, so a 16 px favicon stays 16 px for the UI to show small.
export const fit = (image: Rgba, box: Box, maxSide: number): Rgba => {
  const size = Math.min(maxSide, Math.max(box.width, box.height));
  const scale = size / Math.max(box.width, box.height);
  const [width, height] = [Math.max(1, Math.round(box.width * scale)), Math.max(1, Math.round(box.height * scale))];
  const [left, top] = [Math.floor((size - width) / 2), Math.floor((size - height) / 2)];
  const data = new Uint8ClampedArray(size * size * 4);
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const [x0, y0] = [box.x + (tx * box.width) / width, box.y + (ty * box.height) / height];
      const [x1, y1] = [box.x + ((tx + 1) * box.width) / width, box.y + ((ty + 1) * box.height) / height];
      const [r = 0, g = 0, b = 0, a = 0] = areaSample(image, x0, y0, x1, y1);
      const at = ((top + ty) * size + left + tx) * 4;
      const unpremultiply = a === 0 ? 0 : 255 / a;
      data.set([r * unpremultiply, g * unpremultiply, b * unpremultiply, a], at);
    }
  }
  return { width: size, height: size, data };
};

// How much of the square is covered, and how far the covered colours stray from their mean, weighted by alpha.
const flatness = (image: Rgba) => {
  let [weight, r, g, b] = [0, 0, 0, 0];
  for (let at = 0; at < image.data.length; at += 4) {
    const alpha = (image.data[at + 3] ?? 0) / 255;
    weight += alpha;
    r += alpha * (image.data[at] ?? 0);
    g += alpha * (image.data[at + 1] ?? 0);
    b += alpha * (image.data[at + 2] ?? 0);
  }
  if (weight === 0) return { fill: 0, spread: 0 };
  const [mr, mg, mb] = [r / weight, g / weight, b / weight];
  let variance = 0;
  for (let at = 0; at < image.data.length; at += 4) {
    const alpha = (image.data[at + 3] ?? 0) / 255;
    const [dr, dg, db] = [(image.data[at] ?? 0) - mr, (image.data[at + 1] ?? 0) - mg, (image.data[at + 2] ?? 0) - mb];
    variance += alpha * (dr * dr + dg * dg + db * db);
  }
  return { fill: weight / (image.width * image.height), spread: Math.sqrt(variance / weight) };
};

// Nothing to show: almost no visible pixels in the source, or one flat colour over most of the fitted icon.
export const blank = (coverage: number, icon: Rgba) => {
  if (coverage < minCoverage) return true;
  const { fill, spread } = flatness(icon);
  return fill >= flat.minFill && spread < flat.maxSpread;
};

export const aspectOf = (shape: { readonly width: number; readonly height: number }) =>
  Math.max(shape.width, shape.height) / Math.min(shape.width, shape.height);

export const plateOf = (image: Rgba): IconPlate => {
  let [opaque, alphaSum, lumaSum] = [0, 0, 0];
  for (let at = 0; at < image.data.length; at += 4) {
    const alpha = (image.data[at + 3] ?? 0) / 255;
    if (alpha >= 0.5) opaque++;
    const luma =
      0.2126 * (image.data[at] ?? 0) + 0.7152 * (image.data[at + 1] ?? 0) + 0.0722 * (image.data[at + 2] ?? 0);
    alphaSum += alpha;
    lumaSum += luma * alpha;
  }
  if (opaque / (image.width * image.height) >= 0.9 || alphaSum === 0) return "none";
  const meanLuma = lumaSum / alphaSum;
  return meanLuma > 215 ? "dark" : meanLuma < 40 ? "light" : "none";
};
