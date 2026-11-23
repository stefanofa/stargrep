import "./client-branch.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useLiveQuery } from "@tanstack/react-db";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { type Library, makeLibrary, onePage } from "../src/lib/library-collection.ts";
import type { LibraryRepo } from "../src/lib/rpc.ts";

afterEach(cleanup);

const repo = (id: number): LibraryRepo => ({
  id: id as LibraryRepo["id"],
  owner: "owner",
  name: `repo-${id}`,
  url: `https://github.com/owner/repo-${id}`,
  description: null,
  summary: null,
  language: null,
  topics: [],
  license: null,
  kind: null,
  archived: false,
  pushedAt: null,
  atoms: [],
  keywords: [],
  starredAt: "2026-01-01T00:00:00.000Z",
  stars: null,
  read: false,
  gone: false,
  icon: null,
  ownerType: null,
  ownerAvatarUrl: null,
});

const server = (starred: Array<LibraryRepo>, failures = 0) => {
  let reads = 0;
  const pending: Array<() => void> = [];
  let arrived = Promise.withResolvers<void>();
  return {
    starred,
    reads: () => reads,
    load: () => {
      const failed = reads++ < failures;
      const answer = [...starred];
      const response = Promise.withResolvers<ReadonlyArray<LibraryRepo>>();
      pending.push(() => (failed ? response.reject(new Error("503")) : response.resolve(answer)));
      arrived.resolve();
      return onePage(response.promise);
    },
    next: async () => {
      await arrived.promise;
      const reply = pending.shift();
      if (reply === undefined) throw new Error("No library request to answer");
      if (pending.length === 0) arrived = Promise.withResolvers<void>();
      return reply;
    },
  };
};

describe("the stars view after a failed library load", () => {
  function Stars({ library }: { library: Library }) {
    const { data, isReady, isLoadingError } = useLiveQuery((q) => q.from({ repo: library.collection }));
    if (isLoadingError)
      return (
        <button type="button" onClick={library.reload}>
          try again
        </button>
      );
    return <p>{isReady ? `${data.length} stars` : "loading"}</p>;
  }

  test("shows the library once try again loads it", async () => {
    const github = server([repo(1)], 1);
    const library = makeLibrary(github.load);
    const { container, getByRole } = render(<Stars library={library} />);
    await act(async () => (await github.next())());
    await waitFor(() => expect(container.textContent).toBe("try again"));

    fireEvent.click(getByRole("button"));
    await act(async () => (await github.next())());
    await waitFor(() => expect(container.textContent).toBe("1 stars"));
  });
});

describe("reload", () => {
  test("reads the library again when called while a reload is in flight", async () => {
    const github = server([repo(1)]);
    const library = makeLibrary(github.load);
    const initial = library.collection.preload();
    (await github.next())();
    await initial;

    const inFlight = library.reload();
    const complete = await github.next();
    github.starred.push(repo(2));
    const last = library.reload();
    complete();
    (await github.next())();
    await Promise.all([inFlight, last]);

    expect([...library.collection.keys()]).toEqual([1, 2]);
    expect(github.reads()).toBe(3);
  });

  test("shares one new read among calls made during the same reload", async () => {
    const github = server([repo(1)]);
    const library = makeLibrary(github.load);
    const initial = library.collection.preload();
    (await github.next())();
    await initial;

    const inFlight = library.reload();
    const complete = await github.next();
    github.starred.push(repo(2));
    const reloads = [inFlight, library.reload(), library.reload(), library.reload()];
    complete();
    (await github.next())();
    await Promise.all(reloads);

    expect([...library.collection.keys()]).toEqual([1, 2]);
    expect(github.reads()).toBe(3);
  });
});
