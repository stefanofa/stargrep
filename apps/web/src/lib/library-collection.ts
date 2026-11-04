import { createCollection } from "@tanstack/db";
import { searchText } from "./keyword.ts";
import { api, type LibraryRepo } from "./rpc.ts";

export interface LibraryEntry extends LibraryRepo {
  readonly text: string;
}

// Each sync run loads the library once and commits it as a snapshot, which replaces every row, so a repo unstarred
// on GitHub leaves the collection at the next reload.
const make = () =>
  createCollection<LibraryEntry, number>({
    id: "library",
    getKey: (repo) => repo.id,
    sync: {
      sync: ({ begin, write, commit, markReady, fail }) => {
        let stopped = false;
        api()
          .library()
          .then(
            ({ repos }) => {
              if (stopped) return;
              begin({ snapshot: true });
              for (const repo of repos) write({ type: "insert", value: { ...repo, text: searchText(repo) } });
              commit();
              markReady();
            },
            (error: unknown) => {
              if (!stopped) fail(error);
            },
          );
        return () => {
          stopped = true;
        };
      },
    },
  });

let library: ReturnType<typeof make> | undefined;

export const getLibrary = () => {
  library ??= make();
  return library;
};

export const reloadLibrary = () => {
  getLibrary()
    .reload()
    .catch(() => {});
};
