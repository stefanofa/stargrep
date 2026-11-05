import "./register.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useLiveQuery } from "@tanstack/react-db";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { type Library, makeLibrary, useRecoveries } from "../src/lib/library-collection.ts";
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
  keywords: [],
  starredAt: "2026-01-01T00:00:00.000Z",
  stars: null,
  read: false,
  icon: null,
  ownerType: null,
  ownerAvatarUrl: null,
});

// A server whose library reads the starred repos at the moment the request arrives and answers a few ms later.
const server = (starred: Array<LibraryRepo>, failures = 0) => {
  let reads = 0;
  return {
    starred,
    reads: () => reads,
    load: () => {
      const failed = reads++ < failures;
      const answer = [...starred];
      return Bun.sleep(10).then(() => (failed ? Promise.reject(new Error("503")) : answer));
    },
  };
};

const settle = () => act(() => Bun.sleep(50));

describe("the stars view after a failed library load", () => {
  function Stars({ library }: { library: Library }) {
    const { data, isReady, isLoadingError } = useLiveQuery((q) => q.from({ repo: library.collection }));
    if (isLoadingError)
      return (
        <button type="button" onClick={library.reload}>
          Try again
        </button>
      );
    return <p>{isReady ? `${data.length} stars` : "loading"}</p>;
  }

  function Page({ library }: { library: Library }) {
    return <Stars key={useRecoveries(library)} library={library} />;
  }

  test("shows the library once Try again loads it", async () => {
    const library = makeLibrary(server([repo(1)], 1).load);
    const { container, getByRole } = render(<Page library={library} />);
    await settle();
    expect(container.textContent).toBe("Try again");

    fireEvent.click(getByRole("button"));
    await settle();
    expect(container.textContent).toBe("1 stars");
  });

  test("shows the library once any reload brings it back", async () => {
    const library = makeLibrary(server([repo(1), repo(2)], 1).load);
    const { container } = render(<Page library={library} />);
    await settle();
    expect(container.textContent).toBe("Try again");

    await act(() => library.reload());
    await settle();
    expect(container.textContent).toBe("2 stars");
  });
});

describe("reload", () => {
  test("reads the library again when called while a reload is in flight", async () => {
    const github = server([repo(1)]);
    const library = makeLibrary(github.load);
    await library.collection.preload();

    const inFlight = library.reload();
    github.starred.push(repo(2));
    const last = library.reload();
    await Promise.all([inFlight, last]);

    expect([...library.collection.keys()]).toEqual([1, 2]);
    expect(github.reads()).toBe(3);
  });

  test("shares one new read among calls made during the same reload", async () => {
    const github = server([repo(1)]);
    const library = makeLibrary(github.load);
    await library.collection.preload();

    const inFlight = library.reload();
    github.starred.push(repo(2));
    await Promise.all([inFlight, library.reload(), library.reload(), library.reload()]);

    expect([...library.collection.keys()]).toEqual([1, 2]);
    expect(github.reads()).toBe(3);
  });
});
