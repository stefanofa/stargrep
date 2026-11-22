import { env } from "cloudflare:workers";
import { topicLogos } from "@stargrep/api/topic-logos";
import { describe, expect, it } from "vitest";
import { serveIcon, workerCache } from "../src/server/icons.ts";

const origin = "https://stargrep.test";
const key = `v1/git/${"a".repeat(40)}.webp`;
const webp = new Uint8Array([82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80]);

const pending: Array<Promise<unknown>> = [];
const route = () => ({
  bucket: env.ICONS,
  cache: workerCache(),
  waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
});
const settled = () => Promise.all(pending.splice(0));

const get = (path: string, init?: RequestInit) => {
  const response = serveIcon(new Request(`${origin}${path}`, init), route());
  if (response === undefined) throw new Error(`${path} was not an icon route`);
  return response;
};

describe("GET /icons/<key>", () => {
  it("serves a stored icon with its type, an ETag, and immutable caching, then answers from the cache", async () => {
    await env.ICONS.put(key, webp, {
      httpMetadata: { contentType: "image/webp", cacheControl: "public, max-age=31536000, immutable" },
    });
    const first = await get(`/icons/${key}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/webp");
    expect(first.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(first.headers.get("etag")).toMatch(/^"[0-9a-f]+"$/);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(webp);

    await settled();
    await env.ICONS.delete(key);
    const second = await get(`/icons/${key}?bust=1`);
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(webp);
  });

  it("serves a stored icon under every key version", async () => {
    for (const version of ["v1", "v2"]) {
      const versioned = `${version}/sha256/${"d".repeat(64)}.webp`;
      await env.ICONS.put(versioned, webp, { httpMetadata: { contentType: "image/webp" } });
      const served = await get(`/icons/${versioned}`);
      expect([versioned, served.status, served.headers.get("content-type")]).toEqual([versioned, 200, "image/webp"]);
    }
    await settled();
  });

  it("serves a topic's logo as an immutable SVG, and an old logo name 404 for a short time", async () => {
    const served = await get(`/icons/logos/${topicLogos.nextjs?.key}`);
    expect([served.status, served.headers.get("content-type"), served.headers.get("cache-control")]).toEqual([
      200,
      "image/svg+xml",
      "public, max-age=31536000, immutable",
    ]);
    expect(await served.text()).toMatch(/^<svg /);
    const old = await get("/icons/logos/nextdotjs.0000000000.svg");
    expect([old.status, old.headers.get("cache-control")]).toEqual([404, "public, max-age=300"]);
  });

  it("answers a well-formed key with no object 404, cacheable for a short time", async () => {
    const missing = await get(`/icons/v1/sha256/${"b".repeat(64)}.webp`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("public, max-age=300");
  });

  it("refuses keys outside the icon shape, traversal, and listing, and never caches the refusal", async () => {
    await env.ICONS.put("readmes/secret", "private");
    for (const path of [
      "/icons/readmes/secret",
      `/icons/v/git/${"a".repeat(40)}.webp`,
      "/icons/",
      "/icons/v1/git/",
      `/icons/v1/git/${"a".repeat(40)}.png`,
      `/icons/v1/git/..%2F..%2Freadmes%2Fsecret`,
      `/icons/v1/../readmes/secret`,
      `/icons/v1/sha256/${"c".repeat(63)}.webp`,
    ]) {
      const refused = await get(path);
      expect([path, refused.status, refused.headers.get("cache-control")]).toEqual([path, 404, "no-store"]);
      expect(await refused.text()).toBe("");
    }
  });

  it("answers only GET and HEAD, and leaves every other path to the next handler", async () => {
    expect((await get(`/icons/${key}`, { method: "POST" })).status).toBe(405);
    expect(serveIcon(new Request(`${origin}/api/repos/1`), route())).toBeUndefined();
  });
});
