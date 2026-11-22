import { describe, expect, it } from "vitest";
import type { SyncStatus, Topic } from "../src/lib/rpc.ts";
import type { CardSource } from "../src/server/card/account.ts";
import { serveCard } from "../src/server/card/serve.tsx";
import type { TopicCardSource } from "../src/server/card/topic.ts";
import { workerCache } from "../src/server/icons.ts";
import { libraryRepos } from "./library-fixture.ts";

const origin = "https://stargrep.test";
const syncedAt = "2026-11-05T10:00:00.000Z";
const revision = `${syncedAt}/2/2/0`;

const pending: Array<Promise<unknown>> = [];
const settled = () => Promise.all(pending.splice(0));

const [libraryRepo] = libraryRepos;
if (libraryRepo === undefined) throw new Error("the library fixture holds no repo");
const { atoms, keywords, starredAt, read, gone, stars, ...listed } = libraryRepo;
const topicPage: Topic = {
  topic: "nextjs",
  repos: 8145,
  ranked: 1057,
  icon: null,
  home: null,
  core: [1, 2, 3].map((place) => ({ ...listed, name: `repo-${place}`, devs: 800 - place, stars: 1000 })),
  built: [],
  related: [],
  people: [],
};

const source = (reads: { count: number }, fail = false, imported = true): CardSource & TopicCardSource => ({
  status: async () => {
    reads.count++;
    if (fail) throw new Error("refused");
    return {
      login: "junodev",
      state: "done",
      requestedAt: null,
      syncedAt: imported ? syncedAt : null,
      waiting: null,
      starredTotal: 412,
      accountType: "user",
      enrichment: { total: 2, read: 2, failed: 0, queued: 0 },
    } as SyncStatus;
  },
  library: async () => libraryRepos,
  languages: async () => ({ login: "junodev", total: 2, languages: [{ language: "Rust", count: 2 }] }),
  cachedResults: async () => [],
  avatar: async () => null,
  topic: async (topic) => {
    reads.count++;
    if (topic !== "nextjs") throw new Error("TOPIC_NOT_FOUND");
    return topicPage;
  },
  cachedTopicResults: async () => [],
});

const reported: Array<unknown> = [];

const get = (path: string, card: CardSource & TopicCardSource, init?: RequestInit) =>
  serveCard(new Request(`${origin}${path}`, init), {
    cache: workerCache(),
    waitUntil: (promise) => void pending.push(promise),
    source: card,
    report: (error) => void reported.push(error),
  });

const sizeOf = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

describe("GET /og/topics/<topic>.png", () => {
  it("draws a topic's card and a shared search's, keeps each 10 minutes, and sends a topic without a page to the site's card", async () => {
    const reads = { count: 0 };
    const card = await get("/og/topics/nextjs.png", source(reads));
    expect([card.status, card.headers.get("content-type"), card.headers.get("cache-control")]).toEqual([
      200,
      "image/png",
      "public, max-age=600",
    ]);
    expect(sizeOf(new Uint8Array(await card.arrayBuffer()))).toEqual({ width: 1200, height: 630 });
    const searched = await get("/og/topics/nextjs.png?q=auth%20libraries", source(reads));
    expect(searched.status).toBe(200);
    const missing = await get("/og/topics/no-such-topic.png", source(reads));
    expect([missing.status, missing.headers.get("location")]).toEqual([302, `${origin}/og.png`]);
    await settled();
    expect((await get("/og/topics/Next.png", source(reads))).status).toBe(404);
    expect(reported.splice(0).map((error) => (error as Error).message)).toEqual(["TOPIC_NOT_FOUND"]);
  });
});

describe("GET /og/<login>.png", () => {
  it("draws a 1200 by 630 PNG on workerd, keeps it a day under the revision it drew, then answers from the cache", async () => {
    const reads = { count: 0 };
    const first = await get(`/og/junodev.png?v=${encodeURIComponent(revision)}`, source(reads));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    expect(first.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(sizeOf(new Uint8Array(await first.arrayBuffer()))).toEqual({ width: 1200, height: 630 });
    await settled();
    const second = await get(`/og/junodev.png?v=${encodeURIComponent(revision)}&utm=x`, source(reads));
    expect(second.status).toBe(200);
    expect(second.headers.get("server-timing")).toBeNull();
    expect(reads.count).toBe(1);
  });

  it("keeps a card for 10 minutes when its address names another revision or none, or nothing is imported", async () => {
    const card = await get("/og/junodev.png?q=rust", source({ count: 0 }));
    expect([card.status, card.headers.get("cache-control")]).toEqual([200, "public, max-age=600"]);
    const unimported = await get("/og/someone-new.png", source({ count: 0 }, false, false));
    expect([unimported.status, unimported.headers.get("cache-control")]).toEqual([200, "public, max-age=600"]);
    await settled();
  });

  it("sends a card it cannot read to the site's card, reports why, and keeps nothing", async () => {
    const reads = { count: 0 };
    for (let attempt = 0; attempt < 2; attempt++) {
      const fallback = await get("/og/octo.png", source(reads, true));
      expect([fallback.status, fallback.headers.get("location")]).toEqual([302, `${origin}/og.png`]);
      await settled();
    }
    expect(reads.count).toBe(2);
    expect(reported.splice(0).map((error) => (error as Error).message)).toEqual(["refused", "refused"]);
  });

  it("answers 404 for an address that names no GitHub login, and 405 for a write", async () => {
    const reads = { count: 0 };
    for (const path of ["/og/not..valid.png", "/og/junodev.jpg", "/og/a/b.png"])
      expect([path, (await get(path, source(reads))).status]).toEqual([path, 404]);
    expect((await get("/og/junodev.png", source(reads), { method: "POST" })).status).toBe(405);
    expect(reads.count).toBe(0);
  });
});
