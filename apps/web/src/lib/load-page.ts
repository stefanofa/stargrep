import { createIsomorphicFn, createServerOnlyFn } from "@tanstack/react-start";
import { serverLoads } from "../server/page-data.ts";
import { whoseOf } from "./audience.ts";
import { loadEngine } from "./engine.ts";
import type { PageRequest, Session, StarsRouteData } from "./page-data.ts";
import {
  accountImage,
  canonicalLinks,
  engineLinks,
  pagePath,
  previewMeta,
  siteDescription,
  siteTitle,
} from "./preview.ts";
import { libraryRevision } from "./sync-status.ts";
import { theirs } from "./whose.ts";

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

// / is the viewer's own stars once they sign in, and the landing until then.
export const loadPage = (
  { login }: { readonly login?: string | undefined },
  session: Session | undefined,
): Promise<StarsRouteData> => {
  if (session === undefined) throw new Error("no session");
  const whose = login ?? session.viewer?.login;
  return whose === undefined
    ? loadEngine().then((engine) => engine.landingFor(session))
    : readPage({ login: whose }, session);
};

// A stars page is titled by whose stars it shows and what it searches, so tabs, history and link previews tell pages
// apart. The landing keeps the site's own title and card.
export const pageHead = (
  loaderData: StarsRouteData | undefined,
  { pathname, query }: { readonly pathname: string; readonly query: string | undefined },
) => {
  if (loaderData === undefined) return {};
  if (loaderData.kind === "landing")
    return {
      meta: previewMeta(loaderData.site, { title: siteTitle, description: siteDescription, path: pathname }),
      links: [...canonicalLinks(loaderData.site, pathname), ...engineLinks(loaderData.site)],
    };
  const path = pagePath(pathname, query);
  const whose = whoseOf(loaderData.audience);
  return {
    meta: previewMeta(loaderData.site, {
      title: query ? `"${query}" in ${theirs(whose)} · ${siteTitle}` : `${theirs(whose)} · ${siteTitle}`,
      description: whose.own ? siteDescription : `Search @${whose.login}'s starred GitHub repos in plain words.`,
      path,
      image: accountImage(
        loaderData.audience.owner.login,
        loaderData.sync === null ? null : libraryRevision(loaderData.sync),
        query,
      ),
    }),
    links: [...canonicalLinks(loaderData.site, path), ...engineLinks(loaderData.site)],
  };
};
