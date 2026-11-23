import { loginKey } from "@stargrep/github/login";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { getRequest, setResponseHeader, setResponseStatus } from "@tanstack/react-start/server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { starredOf, whoseOf } from "../lib/audience.ts";
import { normalize, searchText } from "../lib/keyword.ts";
import {
  type Asked,
  askedPage,
  type FirstAnswer,
  type Hits,
  type PageData,
  type PageRequest,
  type Session,
} from "../lib/page-data.ts";
import { liveView, type Semantic } from "../lib/page-view.ts";
import { now } from "../lib/present.ts";
import { api, type Client, type LibraryRepo, type PublicConfig, type SyncStatus, type Viewer } from "../lib/rpc.ts";
import { validateParams } from "../lib/search-params.ts";
import { stageOf } from "../lib/search-state.ts";
import { minimumLength } from "../lib/search-stream.ts";
import { allStars, findStar } from "../lib/stars-pages.ts";
import { storedView } from "../lib/stored-view.ts";
import { libraryRevision } from "../lib/sync-status.ts";
import { rememberedRefusal } from "../lib/trouble.ts";
import type { Whose } from "../lib/whose.ts";
import { type Computed, cachedFirstAnswer, firstAnswerKey } from "./first-answers.ts";
import { inProcess } from "./in-process.ts";
import { indexable } from "./robots.ts";

const hasSession = (request: Request) =>
  /(^|;\s*)(__Secure-)?better-auth\.session_token=/.test(request.headers.get("cookie") ?? "");

const viewerOf = async (client: Client, request: Request): Promise<Viewer | null> => {
  if (!hasSession(request)) return null;
  // The API logs its own failures, so a viewer it could not read renders the visitor's page.
  return client.viewer().catch(() => null);
};

interface Asking {
  readonly login: string;
  readonly query: string;
  readonly sort: Asked["sort"];
  readonly whose: Whose;
  // How many stars the page says the login has: the viewer's own count on their page, or the sync's.
  readonly starred: (sync: SyncStatus) => number | null;
}

// What the page shows for the query from the imported library: its keyword matches, and the answer by meaning when the
// server has one. Without one, the view says the search by meaning is still to come, as the browser's own view does
// until its search answers.
const firstView = (
  repos: ReadonlyArray<LibraryRepo>,
  sync: SyncStatus,
  { query, sort, whose, starred }: Asking,
  hits: Hits | null,
): FirstAnswer => {
  const entries = repos.map((repo) => ({ ...repo, text: searchText(repo) }));
  const byId = new Map(entries.map((entry) => [entry.id as number, entry]));
  const at = now();
  const semantic: Semantic =
    hits !== null
      ? { kind: "answered", results: hits.results }
      : normalize(query).length < minimumLength
        ? { kind: "none" }
        : { kind: "pending", results: [] };
  const view = liveView({
    query,
    stage: stageOf({ sync, entries, starred: starred(sync) }),
    entries,
    find: (id) => byId.get(id),
    sync,
    semantic,
    sort: sort ?? "best",
    at,
    timeLeft: undefined,
    whose,
  });
  return { query, at, sync, hits, view };
};

// The search answer and when the API stored it, which bounds how long a page built from it stays fresh.
const searched = async (login: string, query: string) => {
  let storedAt: number | undefined;
  const client = inProcess((response) => {
    const at = Number(response.headers.get("x-answer-stored-at"));
    if (Number.isSafeInteger(at) && at > 0) storedAt = at;
  });
  const answer = await client.search({ scope: { kind: "stars", login }, q: query });
  return { answer, searchedAt: storedAt ?? now() };
};

// The demo landing's own query is the one answer the server searches for, so the model work an HTML request can cause
// is bounded to it, and it is cached. The API module binds Cloudflare's env, which only the Worker has, so it loads with
// the first page that needs it.
const demoAnswer = async (request: Request, client: Client, sync: SyncStatus, asking: Asking) => {
  const { answers, waitUntil } = await import("./app.ts");
  const { login, query, sort } = asking;
  const compute = async (): Promise<Computed> => {
    const [repos, { answer, searchedAt }] = await Promise.all([allStars(client, login), searched(login, query)]);
    return {
      first: firstView(repos, sync, asking, { results: answer.results, stale: false }),
      searchedAt,
      keep: answer.planSource !== "fallback",
    };
  };
  const build = import.meta.env.STARGREP_BUILD ?? "source";
  const { first, outcome } = await cachedFirstAnswer({
    store: answers(request),
    key: firstAnswerKey(build, loginKey(login), libraryRevision(sync), normalize(query), sort ?? "best"),
    compute,
    background: waitUntil,
  });
  setResponseHeader("x-answer-cache", outcome);
  return first;
};

// A shared link's first answer and opened repo read the owner's whole library, 1,000 stars a page. Read one page after
// another, a cold 15,000 stars kept a page from its first byte for 38 s, longer than link previews and crawlers wait.
// So the server waits this long at most, and past it paints the page as a navigation in the browser does, which then
// loads the library itself.
const libraryWait = Duration.seconds(2);

const withinLibraryWait = <A>(read: Promise<A>) =>
  Effect.runPromise(Effect.promise(() => read).pipe(Effect.timeoutOption(libraryWait), Effect.map(Option.getOrNull)));

// Any other query, a shared link's or a crawler's, is never searched on the server, so an HTML request spends no model
// work. The page paints the answer by meaning when the API's answer cache already holds one, and keyword matches alone
// when it doesn't. The browser then asks for the search by meaning through the API, unless the answer was fresh.
const sharedAnswer = async (
  request: Request,
  config: PublicConfig,
  client: Client,
  sync: SyncStatus,
  asking: Asking,
) => {
  const [{ answers }, { cachedSearch }] = await Promise.all([import("./app.ts"), import("@stargrep/api/router")]);
  const input = { scope: { kind: "stars" as const, login: asking.login }, q: asking.query };
  const [repos, cached] = await Promise.all([
    allStars(client, asking.login),
    Effect.runPromise(cachedSearch(input, { answerCache: answers(request), publicConfig: config })),
  ]);
  setResponseHeader("x-answer-cache", cached.outcome);
  const hits = cached.outcome === "miss" ? null : { results: cached.answer.results, stale: cached.outcome === "stale" };
  return firstView(repos, sync, asking, hits);
};

const loadSession = async (): Promise<Session> => {
  const request = getRequest();
  const client = api();
  const [viewer, config, repoStars] = await Promise.all([
    viewerOf(client, request),
    client.config(),
    import("./app.ts").then(({ headerStars }) => headerStars(new URL(request.url).origin)).catch(() => null),
  ]);
  return {
    viewer,
    config,
    repoStars,
    site: { origin: new URL(request.url).origin, indexable: indexable(request.url) },
  };
};

const loadPage = async ({ login }: PageRequest, { viewer, config, repoStars, site }: Session): Promise<PageData> => {
  const request = getRequest();
  const client = api();
  const cookies = request.headers.get("cookie");
  const { q, sort, repo } = validateParams(Object.fromEntries(new URL(request.url).searchParams));
  const { audience, query, defaultQuery } = askedPage(viewer, config, { login, q });
  const owner = audience.owner.login;
  // The server reads the sync first: it names the library revision a cached answer must match, and only a library an
  // import has written gets a first answer or a panel. Crawlers and link previews render pages too, so the server paints
  // an import under way, a place in line, or a login ready to import, and the browser asks for the import. A login
  // GitHub didn't have when Stargrep last looked paints as missing, with a 404. A refusal this browser saw for a login
  // still unknown paints again, so a reload doesn't ask GitHub again.
  const sync = await client.syncStatus({ login: owner }).catch(() => null);
  const imported = sync !== null && sync.syncedAt !== null ? sync : null;
  const asking: Asking = {
    login: owner,
    query,
    sort,
    whose: whoseOf(audience),
    starred: (status) => starredOf(audience, status),
  };
  const answer = (library: SyncStatus) =>
    audience.owner.demo && query === config.demoQuery
      ? demoAnswer(request, client, library, asking)
      : withinLibraryWait(sharedAnswer(request, config, client, library, asking));
  const [first, opened] = await Promise.all([
    imported === null || query === "" ? null : answer(imported).catch(() => null),
    imported === null || repo === undefined ? null : withinLibraryWait(findStar(client, owner, repo)).catch(() => null),
  ]);
  const remembered =
    first === null && (sync === null || sync.state === "unknown") ? rememberedRefusal(cookies, owner) : undefined;
  const refusal = sync?.state === "missing" ? "missing" : (remembered ?? null);
  if (refusal === "missing") setResponseStatus(404);
  const view = storedView(cookies) ?? null;
  return {
    audience,
    repoStars,
    site,
    config,
    query,
    defaultQuery,
    first,
    sync,
    refusal,
    opened,
    view,
  };
};

// The router sends a failed loader's error to the browser in the page's hydration data. So the server logs an unexpected
// error and hands the router one that says nothing. A redirect or a not-found passes through, since the router acts on it.
const shielded =
  <A extends ReadonlyArray<unknown>, B>(loader: string, load: (...args: A) => Promise<B>) =>
  (...args: A): Promise<B> =>
    load(...args).catch(async (error: unknown) => {
      if (isRedirect(error) || isNotFound(error)) throw error;
      // A report that fails never stands between the visitor and the error that says nothing.
      await import("./app.ts")
        .then(({ reportFailure }) => reportFailure("Page loader failed", { loader }, error, getRequest()))
        .catch(() => undefined);
      throw new Error("stargrep could not load this page");
    });

export const serverLoads = { session: shielded("session", loadSession), page: shielded("page", loadPage) };
