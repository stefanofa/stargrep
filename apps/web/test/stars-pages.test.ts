import { describe, expect, test } from "bun:test";
import { createORPCErrorFromJson } from "@orpc/client";
import type { Client, LibraryRepo } from "../src/lib/rpc.ts";
import { allStars, findStar, starsPages } from "../src/lib/stars-pages.ts";

type Page = Awaited<ReturnType<Client["stars"]>>;

const repo = (id: number) => ({ id, owner: "owner", name: `repo-${id}` }) as unknown as LibraryRepo;

// A library of pages of three repos, page n holding repos n1 to n3. The first page answers at once, and each later page
// waits for answer(n).
const server = (pages: number, { named = true } = {}) => {
  const later = Array.from({ length: pages - 1 }, (_, index) => `${index + 2}000-1`);
  const pageOf = (index: number): Page => ({
    login: "ada",
    repos: [1, 2, 3].map((n) => repo(index * 10 + n)),
    nextCursor: later[index] ?? null,
    labels: {},
    ...(index === 0 && named ? { cursors: later } : {}),
  });
  const asked: Array<string | undefined> = [];
  const waiting = new Map<string, PromiseWithResolvers<Page>>();
  const client = {
    stars: ({ cursor }: { cursor?: string }) => {
      asked.push(cursor);
      if (cursor === undefined) return Promise.resolve(pageOf(0));
      const reply = Promise.withResolvers<Page>();
      waiting.set(cursor, reply);
      return reply.promise;
    },
  } as unknown as Pick<Client, "stars">;
  const answer = (page: number) => waiting.get(later[page - 1] ?? "")?.resolve(pageOf(page));
  const fail = (page: number, error: unknown) => waiting.get(later[page - 1] ?? "")?.reject(error);
  return { client, asked, answer, fail, pageOf };
};

const ids = (page: ReadonlyArray<LibraryRepo>) => page.map((found) => found.id as number);
const settled = () => Bun.sleep(0);

describe("a login's stars", () => {
  test("a library of one page takes one request", async () => {
    const { client, asked } = server(1);
    expect((await allStars(client, "ada")).map((found) => found.id as number)).toEqual([1, 2, 3]);
    expect(asked).toEqual([undefined]);
  });

  test("later pages load four at a time and arrive in page order", async () => {
    const { client, asked, answer } = server(7);
    const pages = starsPages(client, "ada");
    expect(ids((await pages.next()).value ?? [])).toEqual([1, 2, 3]);
    const second = pages.next();
    await settled();
    expect(asked).toEqual([undefined, "2000-1", "3000-1", "4000-1", "5000-1"]);

    answer(2);
    answer(1);
    expect(ids((await second).value ?? [])).toEqual([11, 12, 13]);
    expect(asked).toHaveLength(6);
    expect(ids((await pages.next()).value ?? [])).toEqual([21, 22, 23]);
    expect(asked).toHaveLength(7);
    answer(3);
    answer(4);
    answer(5);
    expect(ids((await pages.next()).value ?? [])).toEqual([31, 32, 33]);
    expect(ids((await pages.next()).value ?? [])).toEqual([41, 42, 43]);
    expect(ids((await pages.next()).value ?? [])).toEqual([51, 52, 53]);
    expect(asked).toEqual([undefined, ...["2", "3", "4", "5", "6", "7"].map((page) => `${page}000-1`)]);
    const last = pages.next();
    answer(6);
    expect(ids((await last).value ?? [])).toEqual([61, 62, 63]);
    expect((await pages.next()).done).toBe(true);
  });

  test("a failed page fails the load after the pages before it, even when it fails first", async () => {
    const { client, answer, fail } = server(4);
    const unhandled: Array<unknown> = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    const pages = starsPages(client, "ada");
    await pages.next();
    const second = pages.next();
    await settled();
    fail(2, new Error("503"));
    await settled();
    answer(1);
    expect(ids((await second).value ?? [])).toEqual([11, 12, 13]);
    await expect(pages.next()).rejects.toThrow("503");
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  test("an answer that names no later pages continues through each page's cursor", async () => {
    const { client, asked, answer } = server(3, { named: false });
    const all = allStars(client, "ada");
    await settled();
    expect(asked).toEqual([undefined, "2000-1"]);
    answer(1);
    await settled();
    expect(asked).toEqual([undefined, "2000-1", "3000-1"]);
    answer(2);
    expect((await all).map((found) => found.id as number)).toEqual([1, 2, 3, 11, 12, 13, 21, 22, 23]);
  });

  test("a repo that moved to the next page between reads is given once", async () => {
    const { pageOf } = server(2);
    const first = pageOf(0);
    const moved = {
      stars: ({ cursor }: { cursor?: string }) =>
        Promise.resolve(
          cursor === undefined ? first : { ...pageOf(1), repos: [first.repos[2], ...pageOf(1).repos] as Page["repos"] },
        ),
    } as unknown as Pick<Client, "stars">;
    expect((await allStars(moved, "ada")).map((found) => found.id as number)).toEqual([1, 2, 3, 11, 12, 13]);
  });

  test("a login Stargrep has not synced has no stars, and finding one stops at the page that holds it", async () => {
    const unsynced = {
      stars: () =>
        Promise.reject(
          createORPCErrorFromJson({ defined: true, code: "ACCOUNT_NOT_SYNCED", message: "", data: undefined }),
        ),
    } as unknown as Pick<Client, "stars">;
    expect(await allStars(unsynced, "nobody")).toEqual([]);

    const { client, answer } = server(3);
    const found = findStar(client, "ada", "owner/repo-12");
    await settled();
    answer(1);
    expect((await found)?.id as number | undefined).toBe(12);
  });
});
