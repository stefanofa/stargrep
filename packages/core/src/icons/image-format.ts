export type RasterFormat = "png" | "jpeg" | "webp";
export type Format = RasterFormat | "svg" | "ico" | "gif" | "avif" | "unknown";

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

export const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export const sniff = (bytes: Uint8Array): Format => {
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (ascii(bytes, 0, 4) === "GIF8") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "ico";
  if (ascii(bytes, 4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 4))) return "avif";
  return /<svg[\s>]/i.test(new TextDecoder().decode(bytes.subarray(0, 4096))) ? "svg" : "unknown";
};

const pngChunks = function* (bytes: Uint8Array) {
  const data = view(bytes);
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const length = data.getUint32(offset);
    yield { type: ascii(bytes, offset + 4, 4), offset };
    offset += 12 + length;
  }
};

export const animated = (format: Format, bytes: Uint8Array) => {
  if (format === "png") {
    for (const chunk of pngChunks(bytes)) {
      if (chunk.type === "acTL") return true;
      if (chunk.type === "IDAT") return false;
    }
    return false;
  }
  return format === "webp" && ascii(bytes, 12, 4) === "VP8X" && ((bytes[20] ?? 0) & 0x02) !== 0;
};

const uint24 = (bytes: Uint8Array, offset: number) =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);

const jpegSize = (bytes: Uint8Array) => {
  const data = view(bytes);
  for (let offset = 2; offset + 9 < bytes.length; ) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: data.getUint16(offset + 7), height: data.getUint16(offset + 5) };
    }
    offset += 2 + data.getUint16(offset + 2);
  }
  return null;
};

export const declaredSize = (format: RasterFormat, bytes: Uint8Array) => {
  if (bytes.length < 30) return null;
  const data = view(bytes);
  switch (format) {
    case "png":
      return { width: data.getUint32(16), height: data.getUint32(20) };
    case "jpeg":
      return jpegSize(bytes);
    case "webp": {
      const chunk = ascii(bytes, 12, 4);
      if (chunk === "VP8X") return { width: uint24(bytes, 24) + 1, height: uint24(bytes, 27) + 1 };
      if (chunk === "VP8L") {
        const bits = data.getUint32(21, true);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      return { width: data.getUint16(26, true) & 0x3fff, height: data.getUint16(28, true) & 0x3fff };
    }
  }
};
