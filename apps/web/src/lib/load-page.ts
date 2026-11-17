import { createIsomorphicFn, createServerOnlyFn } from "@tanstack/react-start";
import { serverLoads } from "../server/page-data.ts";
import { loadEngine } from "./engine.ts";
import type { PageData, PageRequest, Session } from "./page-data.ts";
import { canonicalLinks, pagePath, previewMeta, siteDescription, siteTitle } from "./preview.ts";
import { revealScript } from "./reveal-script.ts";
import { theirs, whoseOf } from "./whose.ts";

// The root route loads the session once, on the server, and never reloads it. Signing in or out reloads the whole page.
export const loadSession = createServerOnlyFn(serverLoads.session);

// The server preloads the engine with the page, so it renders in one pass. A navigation in the browser loads the engine
// too, and the page starts from what the browser already knows.
const readPage = createIsomorphicFn()
  .server(async (request: PageRequest, session: Session) => {
    const [page] = await Promise.all([serverLoads.page(request, session), loadEngine()]);
    return page;
  })
  .client(async (request: PageRequest, session: Session) => (await loadEngine()).pageFor(request, session));

export const loadPage = (request: PageRequest, session: Session | undefined): Promise<PageData> => {
  if (session === undefined) throw new Error("no session");
  return readPage(request, session);
};

// A stars page is titled by whose stars it shows and what it searches, so tabs, history and link previews tell pages
// apart. The home page a visitor lands on keeps the site's own title. The reveal types the demo query once per visit, on a
// page the server painted with its first answer for that query, and never over a shared link's own query. Its script
// runs in the head before the first paint, so it renders on that page alone.
export const pageHead = (
  loaderData: PageData | undefined,
  home: boolean,
  { pathname, query }: { readonly pathname: string; readonly query: string | undefined },
) => {
  if (loaderData === undefined) return {};
  const path = pagePath(pathname, query);
  const landing = home && !loaderData.own;
  const whose = theirs(whoseOf(loaderData));
  return {
    meta: previewMeta(loaderData.site, {
      title: landing ? siteTitle : query ? `"${query}" in ${whose} · ${siteTitle}` : `${whose} · ${siteTitle}`,
      description:
        landing || loaderData.own
          ? siteDescription
          : `Search @${loaderData.owner}'s starred GitHub repos in plain words.`,
      path,
    }),
    links: canonicalLinks(loaderData.site, path),
    scripts:
      loaderData.first != null && loaderData.first.query === loaderData.defaultQuery
        ? [{ children: revealScript }]
        : [],
  };
};
