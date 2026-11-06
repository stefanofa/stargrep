import { loadEngine } from "./engine.ts";
import type { PageData, PageRequest, Session } from "./page-data.ts";

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

export const loadSession = async (): Promise<Session> =>
  import.meta.env.SSR ? onServer().session() : (await loadEngine()).loadSession();

// The server preloads the engine with the page, so it renders in one pass. A navigation in the browser happens after
// the engine has loaded, so it reads the page through the engine's client.
export const loadPage = async (request: PageRequest, known: Session | undefined): Promise<PageData> => {
  const session = known ?? (await loadSession());
  if (import.meta.env.SSR) {
    const [page] = await Promise.all([onServer().page(request, session), loadEngine()]);
    return page;
  }
  return (await loadEngine()).loadPage(request, session);
};
