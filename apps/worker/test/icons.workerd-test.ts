import { Normalize } from "@stargrep/core/icons";
import type { IconSource } from "@stargrep/db";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { codecs } from "../src/icons/codecs.ts";

const images = import.meta.glob<string>(["./fixtures/icons/*", "!**/*.svg"], {
  query: "?inline",
  import: "default",
  eager: true,
});
const svgs = import.meta.glob<string>("./fixtures/icons/*.svg", { query: "?raw", import: "default", eager: true });

const bytesOf = (name: string) => {
  const path = `./fixtures/icons/${name}`;
  const svg = svgs[path];
  if (svg !== undefined) return new TextEncoder().encode(svg);
  const dataUrl = images[path];
  if (dataUrl === undefined) throw new Error(`no fixture ${name}`);
  return Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), (char) => char.charCodeAt(0));
};

const { normalize } = Normalize.make(codecs);
const run = (name: string, source: IconSource = "repo-file") => Effect.runPromise(normalize(bytesOf(name), source));

const accepted = async (name: string, source?: IconSource) => {
  const result = await run(name, source);
  if (result._tag !== "Accepted") throw new Error(`${name} was rejected: ${result.reason}`);
  return result;
};

const webpSize = (webp: Uint8Array) => {
  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
  return {
    riff: new TextDecoder().decode(webp.subarray(0, 4)),
    format: new TextDecoder().decode(webp.subarray(8, 12)),
    length: view.getUint32(4, true) + 8,
  };
};

describe("icon normalization", () => {
  it.each([
    ["ds4-logo.svg", "light", 128],
    ["shaders-icon.svg", "dark", 128],
    ["raea-cat-white.svg", "dark", 128],
    ["raea-cat-black.svg", "light", 128],
    ["atomic-chat-logo.png", "none", 128],
    ["formisch-icon.jpg", "none", 128],
    ["formisch.webp", "none", 64],
    ["formisch.ico", "none", 48],
    ["next-favicon.ico", "light", 128],
    ["cdnjs-favicon.svg", "none", 128],
    ["sandstorm-favicon.ico", "light", 16],
  ] as const)("accepts %s as a WebP with plate %s, %i px and never upscaled", async (name, plate, size) => {
    const result = await accepted(name);
    expect({ plate: result.plate, size: result.size }).toEqual({ plate, size });
    expect(webpSize(result.webp)).toMatchObject({ riff: "RIFF", format: "WEBP", length: result.webp.byteLength });
    expect(result.webp.byteLength).toBeLessThan(16 * 1024);
  });

  it.each([
    ["raea-banner.png", "repo-file", "not-square"],
    ["spinner.gif", "repo-file", "unsupported"],
    ["spinner.png", "repo-file", "animated"],
    ["spinner.webp", "repo-file", "animated"],
    ["script.svg", "repo-file", "unsafe-svg"],
    ["tiny.png", "repo-file", "too-small"],
    ["oversized.png", "readme-image", "oversized"],
    ["blank.svg", "homepage", "blank"],
    ["partykit-emoji.svg", "homepage", "blank"],
  ] as const)("rejects %s from a %s as %s", async (name, source, reason) => {
    expect(await run(name, source)).toEqual(Normalize.Normalized.Rejected({ reason }));
  });

  it("accepts a large image from a repo file that it rejects from a README", async () => {
    expect((await run("oversized.png", "repo-file"))._tag).toBe("Accepted");
  });
});
