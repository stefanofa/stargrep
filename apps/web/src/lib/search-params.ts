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
  // The library shows only the stars of a UTC month or day, such as 2025-12 or 2026-03-10.
  readonly starred?: string | undefined;
  // The library shows only the repos that carry this GitHub topic.
  readonly topic?: string | undefined;
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

const period = /^\d{4}-\d\d(-\d\d)?$/;

// A param that is set, or nothing, so a params object never holds a key set to undefined.
const set = <K extends keyof Params>(key: K, value: Params[K]) => (value === undefined ? {} : { [key]: value });

export const validateParams = (search: Record<string, unknown>): Params => ({
  ...set("q", typeof search.q === "string" ? search.q : undefined),
  ...set("view", search.view === "list" || search.view === "tiles" ? search.view : undefined),
  ...set("sort", isSort(search.sort) ? search.sort : undefined),
  ...set("lang", text(search.lang)),
  ...set("archived", search.archived === true || undefined),
  ...set("starred", text(search.starred)?.match(period)?.[0]),
  ...set("topic", text(search.topic)),
  ...set("show", search.show === "new" ? "new" : undefined),
  ...set("repo", text(search.repo)),
  ...set("error", text(search.error)),
});

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
