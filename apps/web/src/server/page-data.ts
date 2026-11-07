import { isNotFound, isRedirect } from "@tanstack/react-router";
import { getRequest } from "@tanstack/react-start/server";
import * as Effect from "effect/Effect";
import { searchText } from "../lib/keyword.ts";
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
import { api, type Client, type Viewer } from "../lib/rpc.ts";
import { validateParams } from "../lib/search-params.ts";
import { stageOf } from "../lib/search-state.ts";
import { allStars } from "../lib/stars-pages.ts";
import { rememberedRefusal } from "../lib/trouble.ts";

const hasSession = (request: Request) =>
  /(^|;\s*)(__Secure-)?better-auth\.session_token=/.test(request.headers.get("cookie") ?? "");

const viewerOf = async (client: Client, request: Request): Promise<Viewer | null> => {
  if (!hasSession(request)) return null;
  // The API logs its own failures, so a viewer it could not read renders the visitor's page.
  return client.viewer().catch(() => null);
};

const firstAnswer = async (client: Client, login: string, query: string, sort: Asked["sort"]) => {
  const [repos, hits, sync] = await Promise.all([
    allStars(client, login),
    client.search({ scope: { kind: "stars", login }, q: query }).then(({ results }) => results),
    client.syncStatus({ login }),
  ]);
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
  return { query, at, sync, hits, view } satisfies FirstAnswer;
};

// The server only reads the sync, since crawlers and link previews render pages too, so it paints an import under way, a
// place in line, or a login ready to import. The browser asks for the import. A refusal this browser saw for a login
// still unknown paints again, so a reload doesn't ask GitHub again.
const syncOf = async (
  client: Client,
  owner: string,
  cookies: string | null,
): Promise<Pick<PageData, "sync" | "refusal">> => {
  const sync = await client.syncStatus({ login: owner }).catch(() => null);
  const refusal = sync === null || sync.state === "unknown" ? rememberedRefusal(cookies, owner) : undefined;
  return { sync, refusal: refusal ?? null };
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
  const { q, sort } = validateParams(Object.fromEntries(new URL(request.url).searchParams));
  const { owner, own, query, defaultQuery, showcase } = pageOwner(viewer, config, { login, q });
  const first =
    showcase && query === config.demoQuery ? await firstAnswer(client, owner, query, sort).catch(() => null) : null;
  const { sync, refusal } =
    first === null ? await syncOf(client, owner, request.headers.get("cookie")) : { sync: first.sync, refusal: null };
  return { viewer, owner, own, config, query, defaultQuery, first, sync, refusal };
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
