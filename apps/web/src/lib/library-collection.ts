import { createCollection } from "@tanstack/db";
import { useEffect, useState } from "react";
import { searchText } from "./keyword.ts";
import { planned } from "./planned.ts";
import { api, type LibraryRepo } from "./rpc.ts";
import { starsPages } from "./stars-pages.ts";

export interface LibraryEntry extends LibraryRepo {
  readonly text: string;
}

type Pages = AsyncIterable<ReadonlyArray<LibraryRepo>>;

async function* onePage(repos: Promise<ReadonlyArray<LibraryRepo>>): Pages {
  yield await repos;
}

// A sync run commits the library as a snapshot, which replaces every row, so a repo unstarred on GitHub leaves the
// collection at the next reload. The first run shows the first page as soon as it lands and appends the rest. Later
// runs gather every page first, so a reload never shows a library cut down to its first page.
export const makeLibrary = (load: () => Promise<ReadonlyArray<LibraryRepo>> | Pages, id = "library") => {
  let shown = false;
  const collection = createCollection<LibraryEntry, number>({
    id,
    getKey: (repo) => repo.id,
    sync: {
      sync: ({ begin, write, commit, markReady, fail }) => {
        let stopped = false;
        const put = (repos: ReadonlyArray<LibraryRepo>, snapshot: boolean) => {
          begin(snapshot ? { snapshot: true } : undefined);
          for (const repo of repos) write({ type: "insert", value: { ...repo, text: searchText(repo) } });
          commit();
        };
        const run = async () => {
          const loaded = load();
          const pages = Symbol.asyncIterator in loaded ? loaded : onePage(loaded);
          const gathered: Array<LibraryRepo> = [];
          let first = true;
          for await (const page of pages) {
            if (stopped) return;
            if (shown) gathered.push(...page);
            else {
              put(page, first);
              if (first) markReady();
            }
            first = false;
          }
          if (stopped) return;
          if (shown) put(gathered, true);
          else if (first) put([], true);
          markReady();
          shown = true;
        };
        run().catch((error: unknown) => {
          if (!stopped) fail(error);
        });
        return () => {
          stopped = true;
        };
      },
    },
  });

  // The collection hands its reload in flight to a later caller, and that run may have read the library before the
  // caller's stars landed. So a call during a run gets a new run after it, which every call until then shares.
  let running: Promise<void> | undefined;
  let next: Promise<void> | undefined;
  const start = () => {
    next = undefined;
    const run: Promise<void> = collection
      .reload()
      .catch(() => {})
      .finally(() => {
        if (running === run) running = undefined;
      });
    running = run;
    return run;
  };
  const reload = (): Promise<void> => {
    if (running === undefined) return start();
    next ??= running.then(start);
    return next;
  };

  return { collection, reload };
};

export type Library = ReturnType<typeof makeLibrary>;

const libraries = new Map<string, Library>();

export const getLibrary = (login: string, own: boolean) => {
  const key = `${own ? "own" : "public"}:${login.toLowerCase()}`;
  const known = libraries.get(key);
  if (known !== undefined) return known;
  const client = planned(api());
  const load = () => (own ? client.library().then(({ repos }) => repos) : starsPages(client, login));
  const library = makeLibrary(load, `library:${key}`);
  libraries.set(key, library);
  return library;
};

// A live query that saw the library fail keeps the error after the library reloads. A view keyed on this count
// remounts with new live queries once the library recovers.
export function useRecoveries(library: Library | undefined) {
  const collection = library?.collection;
  const [recoveries, setRecoveries] = useState(0);
  useEffect(
    () =>
      collection?.on("status:change", ({ previousStatus, status }) => {
        if (previousStatus === "error" && status === "ready") setRecoveries((count) => count + 1);
      }),
    [collection],
  );
  return recoveries;
}
