import { loadEngine } from "./engine.ts";
import type { PageData, PageRequest, Session } from "./page-data.ts";
import { revealScript } from "./reveal-script.ts";

export interface ServerLoads {
  readonly session: () => Promise<Session>;
  readonly page: (request: PageRequest, session: Session) => Promise<PageData>;
}

let server: ServerLoads | undefined;

// The Worker entry hands over the loaders that read the page in this Worker, so client code never names server modules.
export const provideServerLoads = (loads: ServerLoads) => {
  server = loads;
};

const onServer = () => {
  if (server === undefined) throw new Error("the Worker entry has not provided the page loaders");
  return server;
};

// The root route loads the session once, on the server, and never reloads it. Signing in or out reloads the whole page.
export const loadSession = async (): Promise<Session> => {
  if (!import.meta.env.SSR) throw new Error("no session in the browser");
  return onServer().session();
};

// The server preloads the engine with the page, so it renders in one pass. A navigation in the browser loads the engine
// too, and the page starts from what the browser already knows.
export const loadPage = async (request: PageRequest, session: Session | undefined): Promise<PageData> => {
  if (session === undefined) throw new Error("no session");
  if (import.meta.env.SSR) {
    const [page] = await Promise.all([onServer().page(request, session), loadEngine()]);
    return page;
  }
  return (await loadEngine()).pageFor(request, session);
};

// The reveal types the demo query once per visit, on a page the server painted with its first answer. Its script runs in
// the head before the first paint, so it renders on that page alone.
export const revealHead = ({ loaderData }: { loaderData?: PageData | undefined }) => ({
  scripts: loaderData?.first == null ? [] : [{ children: revealScript }],
});
