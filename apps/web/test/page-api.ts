import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { Caller } from "@stargrep/api/caller";
import { IconHost } from "@stargrep/api/icon-host";
import { RateLimiter } from "@stargrep/api/rate-limiter";
import { NotSignedIn, Viewers } from "@stargrep/api/viewers";
import { QueryPlan, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import type { GitHubAccountId, Login, RepoId, RepoName } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Client } from "../src/lib/rpc.ts";
import { testServer } from "./serve.ts";

// The real API behind the stars pages, with fake services: the demo account stefanofa is synced with three stars in two
// pages, of which mobile-mcp answers the demo query and asciinema, on the second page, is new and not read yet; octodone
// is synced with the same three stars and no answer by meaning; octosync is importing, two stars in; every other login
// is unknown, and ghost-login is no one on GitHub. Each process keeps its own record of the imports it was asked for.

const at = DateTime.makeUnsafe("2026-11-01T08:00:00Z");

const repo = (id: number, owner: string, name: string, description: string): Db.Repo => ({
  id: id as RepoId,
  owner: owner as Login,
  name: name as RepoName,
  nodeId: null,
  description,
  topics: [],
  language: "TypeScript",
  license: "MIT",
  homepage: null,
  kind: "library",
  createdAt: null,
  pushedAt: at,
  archived: false,
  readmeOid: null,
  summary: description,
  summaryReadmeOid: null,
  keywords: [],
  embeddingModel: null,
  icon: null,
  iconCheckedAt: null,
  ownerType: "org",
  ownerAvatarUrl: null,
});

export const demoRepos = [
  repo(1, "mobile-next", "mobile-mcp", "Let an AI agent control your iPhone and Android phone through MCP."),
  repo(2, "junegunn", "fzf", "A command-line fuzzy finder."),
  { ...repo(3, "asciinema", "asciinema", "Terminal session recorder."), pushedAt: null },
];

const perPage = 2;

const accounts: Record<string, { id: number; repos: ReadonlyArray<Db.Repo>; synced: boolean }> = {
  stefanofa: { id: 11, repos: demoRepos, synced: true },
  octodone: { id: 13, repos: demoRepos, synced: true },
  octosync: { id: 12, repos: demoRepos.slice(1), synced: false },
};

const accountOf = (login: string) => {
  const found = accounts[login.toLowerCase()];
  return found === undefined
    ? Option.none()
    : Option.some({
        id: found.id as GitHubAccountId,
        login: login.toLowerCase() as Login,
        type: "user" as const,
        starredCount: found.synced ? found.repos.length : 10,
        starsSyncedAt: found.synced ? at : null,
      });
};

export const requested: Array<string> = [];

const looked = { starredTotal: 10, accountType: "user" } as const;

const syncRequests = Layer.mock(SyncRequests.SyncRequests, {
  request: Effect.fn("SyncRequests.request")(function* (login: Login) {
    requested.push(login);
    if (login === "ghost-login") return yield* new SyncRequests.LoginNotFound({ login });
    return { state: "queued", requestedAt: yield* DateTime.now, syncedAt: null, ...looked } as const;
  }),
  status: (login: Login) =>
    Effect.succeed(
      login.toLowerCase() === "stefanofa" || login.toLowerCase() === "octodone"
        ? { state: "done", syncedAt: at, starredTotal: demoRepos.length, accountType: "user" }
        : login.toLowerCase() === "octosync"
          ? { state: "queued", requestedAt: at, syncedAt: null, ...looked }
          : { state: "unknown", starredTotal: null, accountType: null },
    ),
});

// Every search the API ran, by query. Planning and embedding run inside search, so no search means no model call.
export const searched: Array<string> = [];

const search = Layer.succeed(
  Search.Search,
  Search.Search.of({
    search: Effect.fn("Search.search")((request: Search.SearchRequest) =>
      Effect.sync(() => searched.push(request.query)).pipe(
        Effect.as({
          plan: QueryPlan.asTyped(request.query, "sentence"),
          planSource: "fallback",
          results:
            request.scope._tag === "stars" && request.scope.login.toLowerCase() === "stefanofa"
              ? [{ repo: demoRepos[0] as Db.Repo, nameMatch: false, textRank: 1, vectorRank: 1, metrics: [] }]
              : [],
        } satisfies Search.SearchOutcome),
      ),
    ),
  }),
);

const db = {
  accounts: { byLogin: (login: Login) => Effect.succeed(accountOf(login)) },
  stars: {
    // The second page takes a moment, as a page past the first does on a big library.
    page: (id: number, { after }: { after: Option.Option<unknown> }) => {
      const entries = (Object.values(accounts).find((account) => account.id === id)?.repos ?? []).map(
        (each, index) => ({
          repo: each,
          starredAt: DateTime.subtract(at, { days: index }),
          stars: each.pushedAt === null ? null : 1000 * (index + 1),
          read: each.pushedAt !== null,
        }),
      );
      const last = entries[perPage - 1];
      return Option.isNone(after)
        ? Effect.succeed({
            entries: entries.slice(0, perPage),
            next:
              last === undefined || entries.length <= perPage
                ? Option.none()
                : Option.some({ starredAt: last.starredAt, repoId: last.repo.id }),
          })
        : Effect.as(Effect.sleep("150 millis"), { entries: entries.slice(perPage), next: Option.none() });
    },
    enrichment: (login: Login) => {
      const found = accounts[login.toLowerCase()];
      const total = found?.synced === false ? 2 : (found?.repos.length ?? 0);
      const unread = found?.repos.filter((each) => each.pushedAt === null).length ?? 0;
      return Effect.succeed({ total, read: total - unread, failed: 0 });
    },
  },
} as unknown as Db.Db["Service"];

export const serveApi = testServer((request) =>
  Layer.mergeAll(
    search,
    syncRequests,
    Layer.succeed(Db.Db, db),
    Layer.succeed(RateLimiter, RateLimiter.of({ acquire: Effect.fn("RateLimiter.acquire")(() => Effect.void) })),
    Layer.succeed(Viewers, Viewers.of({ current: Effect.fail(new NotSignedIn()), signedIn: Effect.succeedNone })),
    Layer.succeed(IconHost, IconHost.of({ origin: new URL(request.url).origin })),
    Layer.succeed(Caller, Caller.of({ key: Db.CallerKey.make("caller-page"), address: "192.0.2.1" })),
  ),
);

// The browser's client, answered by the same API in this process.
export const browserClient = (): Client =>
  createORPCClient(
    new RPCLink({
      url: "/rpc",
      origin: "http://localhost",
      fetch: (url, init) => serveApi(new Request(url, init)) ?? Promise.resolve(new Response(null, { status: 404 })),
    }),
  );
