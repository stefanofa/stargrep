import { loginKey } from "@stargrep/github/login";
import type { Sort, View } from "@stargrep/ui";

export interface Params {
  // An empty q is a search someone cleared, which differs from no q on a page with a default query.
  readonly q?: string | undefined;
  readonly view?: View | undefined;
  readonly sort?: Sort | undefined;
  readonly lang?: string | undefined;
  // The library shows only the archived repos the account starred.
  readonly archived?: true | undefined;
  // Someone else's page shows everything new to the signed-in viewer in place of the months.
  readonly show?: "new" | undefined;
  readonly repo?: string | undefined;
  readonly error?: string | undefined;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

// Route options stay in the entry chunk, so this module imports nothing from the UI package at runtime.
export const searchSorts: ReadonlyArray<Sort> = ["best", "starred", "stars", "pushed"];

export const librarySorts = searchSorts.filter((sort) => sort !== "best");

const isSort = (value: unknown): value is Sort => searchSorts.some((sort) => sort === value);

export const validateParams = (search: Record<string, unknown>): Params => {
  const q = typeof search.q === "string" ? search.q : undefined;
  const [lang, repo, error] = [text(search.lang), text(search.repo), text(search.error)];
  return {
    ...(q === undefined ? {} : { q }),
    ...(search.view === "list" || search.view === "tiles" ? { view: search.view } : {}),
    ...(isSort(search.sort) ? { sort: search.sort } : {}),
    ...(lang === undefined ? {} : { lang }),
    ...(search.archived === true ? { archived: true } : {}),
    ...(search.show === "new" ? { show: "new" } : {}),
    ...(repo === undefined ? {} : { repo }),
    ...(error === undefined ? {} : { error }),
  };
};

// Single-segment paths the Worker or the router answers before a login page could. These logins live at /@login, which
// every login also accepts.
export const reservedLogins: ReadonlyArray<string> = [
  "api",
  "assets",
  "auth",
  "developers",
  "following",
  "health",
  "icons",
  "mcp",
  "people",
  "privacy",
  "rpc",
  "search",
  "terms",
  "topics",
];

export const reservedLogin = (login: string) => reservedLogins.includes(loginKey(login));
