import { createCollection } from "@tanstack/db";
import { useEffect, useState } from "react";
import { searchText } from "./keyword.ts";
import type { PlannedRepo } from "./planned.ts";
import { api, type LibraryRepo } from "./rpc.ts";

export interface LibraryEntry extends LibraryRepo, PlannedRepo {
  readonly text: string;
}

// Each sync run loads the library once and commits it as a snapshot, which replaces every row, so a repo unstarred
// on GitHub leaves the collection at the next reload.
export const makeLibrary = (load: () => Promise<ReadonlyArray<LibraryRepo>>) => {
  const collection = createCollection<LibraryEntry, number>({
    id: "library",
    getKey: (repo) => repo.id,
    sync: {
      sync: ({ begin, write, commit, markReady, fail }) => {
        let stopped = false;
        load().then(
          (repos) => {
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

let library: Library | undefined;

export const getLibrary = () => {
  library ??= makeLibrary(() =>
    api()
      .library()
      .then(({ repos }) => repos),
  );
  return library;
};

// A live query that saw the library fail keeps the error after the library reloads. A view keyed on this count
// remounts with new live queries once the library recovers.
export function useRecoveries({ collection }: Library) {
  const [recoveries, setRecoveries] = useState(0);
  useEffect(
    () =>
      collection.on("status:change", ({ previousStatus, status }) => {
        if (previousStatus === "error" && status === "ready") setRecoveries((count) => count + 1);
      }),
    [collection],
  );
  return recoveries;
}
