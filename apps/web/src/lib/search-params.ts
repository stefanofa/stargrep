import type { Sort, View } from "@stargrep/ui";

export interface Params {
  readonly q?: string | undefined;
  readonly view?: View | undefined;
  readonly sort?: Sort | undefined;
  readonly lang?: string | undefined;
  readonly repo?: string | undefined;
  readonly error?: string | undefined;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

// Route options stay in the entry chunk, so this module imports nothing from the UI package at runtime.
export const searchSorts: ReadonlyArray<Sort> = ["best", "starred", "stars", "pushed"];

export const librarySorts = searchSorts.filter((sort) => sort !== "best");

const isSort = (value: unknown): value is Sort => searchSorts.some((sort) => sort === value);

export const validateParams = (search: Record<string, unknown>): Params => {
  const [q, lang, repo, error] = [text(search.q), text(search.lang), text(search.repo), text(search.error)];
  return {
    ...(q === undefined ? {} : { q }),
    ...(search.view === "list" || search.view === "tiles" ? { view: search.view } : {}),
    ...(isSort(search.sort) ? { sort: search.sort } : {}),
    ...(lang === undefined ? {} : { lang }),
    ...(repo === undefined ? {} : { repo }),
    ...(error === undefined ? {} : { error }),
  };
};

export const githubLogin = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
