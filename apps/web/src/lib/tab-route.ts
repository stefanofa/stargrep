import { lazyRouteComponent } from "@tanstack/react-router";
import type { ComponentType } from "react";
import { Failure } from "../components/problem-page.tsx";
import type { Session } from "./page-data.ts";

// What a tab of a person's page beside stars exports from its own chunk: a loader that answers the login and the deps
// its address names with the page's data and head, the page as it will stand while that loads, and the page.
export interface TabChunk<Deps, Data extends { readonly head: object }> {
  readonly load: (login: string, session: Session | undefined, deps: Deps) => Promise<Data>;
  readonly Loading: ComponentType;
  readonly Page: ComponentType;
}

// The route options every such tab shares, so the landing entry, which holds every route, carries them once.
export const tabRoute = <Deps, Data extends { readonly head: object }>(chunk: () => Promise<TabChunk<Deps, Data>>) => ({
  loader: async ({
    params,
    deps,
    parentMatchPromise,
  }: {
    params: { login: string };
    deps: Deps;
    parentMatchPromise: Promise<{ loaderData?: Session | undefined }>;
  }) => (await chunk()).load(params.login, (await parentMatchPromise).loaderData, deps),
  head: ({ loaderData }: { loaderData?: Data | undefined }) => loaderData?.head ?? {},
  pendingComponent: lazyRouteComponent(chunk, "Loading"),
  component: lazyRouteComponent(chunk, "Page"),
  errorComponent: Failure,
});
