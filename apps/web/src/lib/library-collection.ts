import { createCollection } from "@tanstack/db";
import { searchText } from "./keyword.ts";
import { api, type LibraryRepo } from "./rpc.ts";

export interface LibraryEntry extends LibraryRepo {
  readonly text: string;
}

// A snapshot commit replaces every row, so a repo unstarred on GitHub leaves the collection at the next load.
const make = () => {
  let load = () => {};
  const collection = createCollection<LibraryEntry, number>({
    id: "library",
    getKey: (repo) => repo.id,
    sync: {
      sync: ({ begin, write, commit, markReady, fail, reportError }) => {
        let ready = false;
        let stopped = false;
        load = () => {
          api()
            .library()
            .then(
              ({ repos }) => {
                if (stopped) return;
                begin({ snapshot: true });
                for (const repo of repos) write({ type: "insert", value: { ...repo, text: searchText(repo) } });
                commit();
                if (!ready) markReady();
                ready = true;
              },
              (error: unknown) => (ready ? reportError(error) : fail(error)),
            );
        };
        load();
        return () => {
          stopped = true;
        };
      },
    },
  });
  return { collection, reload: () => load() };
};

let library: ReturnType<typeof make> | undefined;

export const getLibrary = () => {
  library ??= make();
  return library;
};
