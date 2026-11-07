import { loginKey } from "@stargrep/github/login";
import { createCollection } from "@tanstack/db";
import { searchText } from "./keyword.ts";
import { api, type LibraryRepo } from "./rpc.ts";
import { starsPages } from "./stars-pages.ts";

export interface LibraryEntry extends LibraryRepo {
  readonly text: string;
}

type Pages = AsyncIterable<ReadonlyArray<LibraryRepo>>;

export async function* onePage(repos: Promise<ReadonlyArray<LibraryRepo>>): Pages {
  yield await repos;
}

// A sync run commits the library as a snapshot, which replaces every row, so a repo unstarred on GitHub leaves the
// collection at the next reload. The first run shows the first page as soon as it lands and appends the rest. Later
// runs gather every page first, so a reload never shows a library cut down to its first page.
export const makeLibrary = (load: () => Pages, id = "library") => {
  let shown = false;
  let failure: unknown;
  // Settles once the first run has every page, or failed.
  let settle = () => {};
  const whole = new Promise<void>((resolve) => {
    settle = resolve;
  });
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
          const pages = load();
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
          settle();
        };
        run().catch((error: unknown) => {
          failure = error;
          settle();
          if (!stopped) fail(error);
        });
        return () => {
          stopped = true;
        };
      },
    },
  });

  // A live query keeps the error of a failed load after the library recovers, so the library reloads its live queries
  // when it does.
  collection.on("status:change", ({ previousStatus, status }) => {
    if (previousStatus !== "error" || status !== "ready") return;
    for (const dependent of collection.subscribers) void dependent.collection?.reload();
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

  return { collection, reload, whole, failure: () => failure };
};

export type Library = ReturnType<typeof makeLibrary>;

const libraries = new Map<string, Library>();

export const getLibrary = (login: string, own: boolean, empty: boolean) => {
  const key = `${own ? "own" : "public"}:${loginKey(login)}`;
  const known = libraries.get(key);
  if (known !== undefined) return known;
  const client = api();
  let skip = empty;
  const load = (): Pages => {
    if (skip) {
      skip = false;
      return onePage(Promise.resolve([]));
    }
    return own ? onePage(client.library().then(({ repos }) => repos)) : starsPages(client, login);
  };
  const library = makeLibrary(load, `library:${key}`);
  libraries.set(key, library);
  return library;
};
