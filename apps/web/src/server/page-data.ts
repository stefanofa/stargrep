import { loginKey } from "@stargrep/github/login";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import * as Effect from "effect/Effect";
import { normalize, searchText } from "../lib/keyword.ts";
import {
  type Asked,
  type FirstAnswer,
  type PageData,
  type PageRequest,
  pageOwner,
  type Session,
} from "../lib/page-data.ts";
import { liveView } from "../lib/page-view.ts";
import { now } from "../lib/present.ts";
import { api, type Client, type SyncStatus, type Viewer } from "../lib/rpc.ts";
import { validateParams } from "../lib/search-params.ts";
import { stageOf } from "../lib/search-state.ts";
import { allStars } from "../lib/stars-pages.ts";
import { storedView } from "../lib/stored-view.ts";
import { libraryRevision } from "../lib/sync-status.ts";
import { rememberedRefusal } from "../lib/trouble.ts";
import { type Computed, cachedFirstAnswer, firstAnswerKey } from "./first-answers.ts";
import { inProcess } from "./in-process.ts";

const hasSession = (request: Request) =>
  /(^|;\s*)(__Secure-)?better-auth\.session_token=/.test(request.headers.get("cookie") ?? "");

const viewerOf = async (client: Client, request: Request): Promise<Viewer | null> => {
  if (!hasSession(request)) return null;
  // The API logs its own failures, so a viewer it could not read renders the visitor's page.
  return client.viewer().catch(() => null);
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

const firstAnswer = async (
  client: Client,
  sync: SyncStatus,
  login: string,
  query: string,
  sort: Asked["sort"],
): Promise<Computed> => {
  const [repos, { answer, searchedAt }] = await Promise.all([allStars(client, login), searched(login, query)]);
  const { results: hits, planSource } = answer;
  const entries = repos.map((repo) => ({ ...repo, text: searchText(repo) }));
  const byId = new Map(entries.map((entry) => [entry.id as number, entry]));
  const at = now();
  const view = liveView({
    query,
    stage: stageOf({ sync, entries, starred: sync.starredTotal }),
    entries,
    find: (id) => byId.get(id),
    sync,
    semantic: { kind: "answered", results: hits },
    sort: sort ?? "best",
    at,
    timeLeft: undefined,
    whose: { own: false, login },
  });
  return { first: { query, at, sync, hits, view } satisfies FirstAnswer, searchedAt, keep: planSource !== "fallback" };
};

// The API module binds Cloudflare's env, which only the Worker has, so it loads with the first page that needs it.
const demoAnswer = async (
  request: Request,
  client: Client,
  sync: SyncStatus,
  login: string,
  query: string,
  sort: Asked["sort"],
) => {
  const { answers, waitUntil } = await import("./app.ts");
  const build = import.meta.env.STARGREP_BUILD ?? "source";
  const { first, outcome } = await cachedFirstAnswer({
    store: answers(request),
    key: firstAnswerKey(build, loginKey(login), libraryRevision(sync), normalize(query), sort ?? "best"),
    compute: () => firstAnswer(client, sync, login, query, sort),
    background: waitUntil,
  });
  setResponseHeader("x-answer-cache", outcome);
  return first;
};

const loadSession = async (): Promise<Session> => {
  const request = getRequest();
  const client = api();
  const [viewer, config] = await Promise.all([viewerOf(client, request), client.config()]);
  return { viewer, config };
};

const loadPage = async ({ login }: PageRequest, { viewer, config }: Session): Promise<PageData> => {
  const request = getRequest();
  const client = api();
  const cookies = request.headers.get("cookie");
  const { q, sort } = validateParams(Object.fromEntries(new URL(request.url).searchParams));
  const { owner, own, query, defaultQuery, showcase } = pageOwner(viewer, config, { login, q });
  // The server reads the sync first, since it names the library revision a cached answer must match. Crawlers and link
  // previews render pages too, so the server paints an import under way, a place in line, or a login ready to import,
  // and the browser asks for the import. A refusal this browser saw for a login still unknown paints again, so a reload
  // doesn't ask GitHub again.
  const sync = await client.syncStatus({ login: owner }).catch(() => null);
  const first =
    showcase && query === config.demoQuery && sync !== null
      ? await demoAnswer(request, client, sync, owner, query, sort).catch(() => null)
      : null;
  const remembered =
    first === null && (sync === null || sync.state === "unknown") ? rememberedRefusal(cookies, owner) : undefined;
  const view = storedView(cookies) ?? null;
  return { viewer, owner, own, config, query, defaultQuery, first, sync, refusal: remembered ?? null, view };
};

// The router sends a failed loader's error to the browser in the page's hydration data. So the server logs an unexpected
// error and hands the router one that says nothing. A redirect or a not-found passes through, since the router acts on it.
const shielded =
  <A extends ReadonlyArray<unknown>, B>(loader: string, load: (...args: A) => Promise<B>) =>
  (...args: A): Promise<B> =>
    load(...args).catch(async (error: unknown) => {
      if (isRedirect(error) || isNotFound(error)) throw error;
      await Effect.runPromise(Effect.logError("Page loader failed", { loader, error: String(error) }));
      throw new Error("stargrep could not load this page");
    });

export const serverLoads = { session: shielded("session", loadSession), page: shielded("page", loadPage) };
