import { view } from "./image-format.ts";
import type { Rgba } from "./pixels.ts";

const maxIcoSide = 256;

interface IcoEntry {
  readonly width: number;
  readonly bytes: Uint8Array;
}

export const icoEntries = (bytes: Uint8Array): ReadonlyArray<IcoEntry> => {
  if (bytes.length < 6) return [];
  const data = view(bytes);
  const count = data.getUint16(4, true);
  return Array.from({ length: count }, (_, index): IcoEntry | null => {
    const at = 6 + index * 16;
    if (at + 16 > bytes.length) return null;
    const length = data.getUint32(at + 8, true);
    const offset = data.getUint32(at + 12, true);
    if (offset + length > bytes.length) return null;
    return { width: bytes[at] || 256, bytes: bytes.subarray(offset, offset + length) };
  }).filter((entry): entry is IcoEntry => entry !== null);
};

const bmpDepths = new Set([1, 4, 8, 24, 32]);

export const decodeBmp = (bytes: Uint8Array): Rgba | null => {
  const data = view(bytes);
  if (bytes.length < 40 || data.getUint32(0, true) < 40) return null;
  const headerSize = data.getUint32(0, true);
  const width = data.getInt32(4, true);
  const height = data.getInt32(8, true) / 2;
  const bits = data.getUint16(14, true);
  if (data.getUint32(16, true) !== 0 || !bmpDepths.has(bits)) return null;
  if (width <= 0 || height <= 0 || width > maxIcoSide || height > maxIcoSide) return null;
  const colors = bits <= 8 ? data.getUint32(32, true) || 2 ** bits : 0;
  const pixelStart = headerSize + colors * 4;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const maskStart = pixelStart + stride * height;
  if (maskStart > bytes.length) return null;
  const sourceOf = (row: number, x: number) => {
    if (bits > 8) return row + (x * bits) / 8;
    const byte = bytes[row + Math.floor((x * bits) / 8)] ?? 0;
    const shift = 8 - bits - ((x * bits) % 8);
    return headerSize + ((byte >> shift) & (2 ** bits - 1)) * 4;
  };
  const pixels = new Uint8ClampedArray(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = pixelStart + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const source = sourceOf(row, x);
      const target = (y * width + x) * 4;
      pixels[target] = bytes[source + 2] ?? 0;
      pixels[target + 1] = bytes[source + 1] ?? 0;
      pixels[target + 2] = bytes[source] ?? 0;
      pixels[target + 3] = bits === 32 ? (bytes[source + 3] ?? 0) : 255;
      anyAlpha ||= bits === 32 && pixels[target + 3] !== 0;
    }
  }
  if (bits !== 32 || !anyAlpha) {
    for (let y = 0; y < height; y++) {
      const row = maskStart + (height - 1 - y) * maskStride;
      for (let x = 0; x < width; x++) {
        const masked = ((bytes[row + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
        pixels[(y * width + x) * 4 + 3] = masked ? 0 : 255;
      }
    }
  }
  return { width, height, data: pixels };
};
