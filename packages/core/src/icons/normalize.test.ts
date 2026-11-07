import { describe, expect, test } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import { sniff } from "./image-format.ts";
import { make, Normalized } from "./normalize.ts";
import { plateOf, type Rgba } from "./pixels.ts";

const unreachable = () => Promise.reject(new Error("the codec should not run"));
const { normalize } = make({ decode: unreachable, renderSvg: unreachable, encodeWebp: unreachable });
const run = (bytes: Uint8Array) => normalize(bytes, "homepage");
const rejected = (reason: Parameters<typeof Normalized.Rejected>[0]["reason"]) => Normalized.Rejected({ reason });

const ico = (entry: { width: number; length: number; offset: number }, body: Uint8Array) => {
  const header = new Uint8Array(22);
  const data = new DataView(header.buffer);
  data.setUint16(2, 1, true);
  data.setUint16(4, 1, true);
  header[6] = entry.width;
  data.setUint32(14, entry.length, true);
  data.setUint32(18, entry.offset, true);
  return new Uint8Array([...header, ...body]);
};

const bmp = (width: number, height: number) => {
  const header = new Uint8Array(40);
  const data = new DataView(header.buffer);
  data.setUint32(0, 40, true);
  data.setInt32(4, width, true);
  data.setInt32(8, height * 2, true);
  data.setUint16(14, 32, true);
  return header;
};

describe("normalize on hostile bytes", () => {
  it.effect("rejects truncated and lying headers without running a codec or throwing", () =>
    Effect.gen(function* () {
      expect(yield* run(new Uint8Array([0, 0, 1, 0]))).toEqual(rejected("undecodable"));
      expect(yield* run(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))).toEqual(rejected("undecodable"));
      expect(yield* run(ico({ width: 0, length: 40, offset: 22 }, bmp(70_000, 70_000)))).toEqual(
        rejected("undecodable"),
      );
      expect(yield* run(ico({ width: 32, length: 9_999, offset: 22 }, bmp(32, 32)))).toEqual(rejected("undecodable"));
      expect(yield* run(new TextEncoder().encode("<html>not an image</html>"))).toEqual(rejected("unsupported"));
    }),
  );

  it.effect("rejects a PNG whose header declares a side past the decode limit before decoding it", () =>
    Effect.gen(function* () {
      const png = new Uint8Array(33);
      png.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
      const data = new DataView(png.buffer);
      data.setUint32(16, 20_000);
      data.setUint32(20, 20_000);
      expect(yield* run(png)).toEqual(rejected("oversized"));
    }),
  );

  test("sniffs formats by their bytes, not their names", () => {
    expect(sniff(new TextEncoder().encode('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>'))).toBe("svg");
    expect(sniff(new TextEncoder().encode("GIF89a"))).toBe("gif");
  });
});

describe("plateOf", () => {
  const filled = (pixel: readonly [number, number, number, number], coverage: number): Rgba => {
    const data = new Uint8ClampedArray(100 * 4);
    for (let index = 0; index < 100 * coverage; index++) data.set(pixel, index * 4);
    return { width: 10, height: 10, data };
  };

  test("asks for a dark tile behind white ink and a light tile behind black ink on transparent", () => {
    expect(plateOf(filled([255, 255, 255, 255], 0.4))).toBe("dark");
    expect(plateOf(filled([10, 10, 10, 255], 0.4))).toBe("light");
    expect(plateOf(filled([200, 40, 40, 255], 0.4))).toBe("none");
  });

  test("leaves an opaque square alone whatever its color", () => {
    expect(plateOf(filled([255, 255, 255, 255], 1))).toBe("none");
  });
});
