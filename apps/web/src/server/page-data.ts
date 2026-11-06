import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { getRequest } from "@tanstack/react-start/server";
import { keywordTerms, searchText } from "../lib/keyword.ts";
import {
  type Asked,
  type FirstAnswer,
  type PageData,
  type PageRequest,
  pageOwner,
  type Session,
} from "../lib/page-data.ts";
import { matchesEvery, pageView } from "../lib/page-view.ts";
import { now } from "../lib/present.ts";
import { refusalOf } from "../lib/refusals.ts";
import type { Client, Viewer } from "../lib/rpc.ts";
import { validateParams } from "../lib/search-params.ts";
import { allStars } from "../lib/stars-pages.ts";
import { serveApi } from "./app.ts";

const forwarded = ["cookie", "cf-connecting-ip", "user-agent"];

// The page calls the API in this Worker, with the visitor's cookie and address, so no request leaves it.
const inProcess = (request: Request): Client => {
  const headers = Object.fromEntries(
    forwarded.flatMap((name) => {
      const value = request.headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  );
  return createORPCClient(
    new RPCLink({
      url: "/rpc",
      origin: new URL(request.url).origin,
      headers,
      fetch: (url, init) => serveApi(new Request(url, init)) ?? Promise.resolve(new Response(null, { status: 404 })),
    }),
  );
};

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
    client.search({ login, q: query }).then(({ results }) => results),
    client.syncStatus({ login }),
  ]);
  const entries = repos.map((repo) => ({ ...repo, text: searchText(repo) }));
  const byId = new Map(entries.map((entry) => [entry.id as number, entry]));
  const at = now();
  const view = pageView({
    query,
    entries,
    matched: matchesEvery(entries, keywordTerms(query)),
    find: (id) => byId.get(id),
    sync,
    starred: sync.starredTotal,
    semantic: { results: hits, pending: false, failed: false },
    sort: sort ?? "best",
    at,
    timeLeft: undefined,
    whose: login,
  });
  return { query, at, sync, hits, view } satisfies FirstAnswer;
};

// The page asks for a sync of someone new as soon as it opens, so the server asks first and paints the answer: an
// import under way, a place in line, or a refusal. The API checks the login and admits the sync as it would for the
// browser, from the visitor's own address.
const syncOf = async (client: Client, owner: string, own: boolean): Promise<Pick<PageData, "sync" | "refusal">> => {
  const status = await client.syncStatus({ login: owner }).catch(() => null);
  if (own || status === null || status.state !== "unknown") return { sync: status, refusal: null };
  return client.triggerSync({ login: owner }).then(
    (sync) => ({ sync, refusal: null }),
    (error: unknown) => ({ sync: status, refusal: refusalOf(error) ?? null }),
  );
};

export const loadSession = async (): Promise<Session> => {
  const request = getRequest();
  const client = inProcess(request);
  const [viewer, config] = await Promise.all([viewerOf(client, request), client.config()]);
  return { viewer, config };
};

export const loadPage = async ({ login }: PageRequest, { viewer, config }: Session): Promise<PageData> => {
  const request = getRequest();
  const client = inProcess(request);
  const { q, sort } = validateParams(Object.fromEntries(new URL(request.url).searchParams));
  const { owner, own, query, showcase } = pageOwner(viewer, config, { login, q });
  const first =
    showcase && query === config.demoQuery ? await firstAnswer(client, owner, query, sort).catch(() => null) : null;
  const { sync, refusal } = first === null ? await syncOf(client, owner, own) : { sync: first.sync, refusal: null };
  return { viewer, owner, own, config, query, first, sync, refusal };
};
