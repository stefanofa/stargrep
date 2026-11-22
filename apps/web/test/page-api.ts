import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import * as AnswerCache from "@stargrep/api/answer-cache";
import { Caller } from "@stargrep/api/caller";
import { IconHost } from "@stargrep/api/icon-host";
import { RateLimiter } from "@stargrep/api/rate-limiter";
import { NotSignedIn, Viewers } from "@stargrep/api/viewers";
import { QueryPlan, Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { UserId } from "@stargrep/db/auth-schema";
import { accountRow, makeDb, repo as repoRow } from "@stargrep/db/testing";
import { GitHubAccountId, Login, RepoId, RepoName } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Client } from "../src/lib/rpc.ts";
import { testServer } from "./serve.ts";

// The real API behind the stars pages, with fake services: the demo account stefanofa is synced with three stars in two
// pages, of which mobile-mcp answers the demo query and asciinema, on the second page, is new and not read yet; octodone
// is synced with the same three stars and no answer by meaning; octosync is importing, two stars in; every other login
// is unknown, ghost-login is no one on GitHub, and gone-login is no one on GitHub as of a lookup minutes ago. Each process
// keeps its own record of the imports it was asked for.
// With STARGREP_SIGNED_IN set to one of those logins, every request comes from that account, signed in.

const at = DateTime.makeUnsafe("2026-11-01T08:00:00Z");

const repo = (id: number, owner: string, name: string, description: string): Db.Repo =>
  repoRow(RepoId.make(id), {
    owner: Login.make(owner),
    name: RepoName.make(name),
    nodeId: null,
    description,
    language: "TypeScript",
    license: "MIT",
    kind: "library",
    pushedAt: at,
    summary: description,
    ownerType: "org",
  });

export const demoRepos = [
  repo(1, "mobile-next", "mobile-mcp", "Let an AI agent control your iPhone and Android phone through MCP."),
  repo(2, "junegunn", "fzf", "A command-line fuzzy finder."),
  { ...repo(3, "asciinema", "asciinema", "Terminal session recorder."), pushedAt: null },
] as const;

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
    : Option.some(
        accountRow(GitHubAccountId.make(found.id), {
          login: Login.make(login.toLowerCase()),
          type: "user" as const,
          starredCount: found.synced ? found.repos.length : 10,
          starsSyncedAt: found.synced ? at : null,
        }),
      );
};

// Each request reads the variable, so a test can sign in its own process too.
const signedIn = () => {
  const login = process.env.STARGREP_SIGNED_IN;
  const account = login === undefined ? Option.none() : accountOf(login);
  return Option.map(account, (found) => ({ userId: UserId.make(`user-${found.id}`), account: found }));
};

const viewers = () => {
  const viewer = signedIn();
  return Viewers.of({
    current: Effect.fromOption(viewer).pipe(Effect.mapError(() => new NotSignedIn())),
    signedIn: Effect.succeed(Option.map(viewer, ({ userId }) => userId)),
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
          : login.toLowerCase() === "gone-login"
            ? { state: "missing", starredTotal: null, accountType: null }
            : { state: "unknown", starredTotal: null, accountType: null },
    ),
});

// Every search the API ran, by query. Planning and embedding run inside search, so no search means no model call.
export const searched: Array<string> = [];

const searchWith = (planSource: Search.SearchOutcome["planSource"], record: (query: string) => void) =>
  Layer.succeed(
    Search.Search,
    Search.Search.of({
      search: Effect.fn("Search.search")((request: Search.SearchRequest) =>
        Effect.sync(() => record(request.query)).pipe(
          Effect.as({
            plan: QueryPlan.asTyped(request.query, "sentence"),
            planSource,
            results:
              request.scope._tag === "stars" && request.scope.login.toLowerCase() === "stefanofa"
                ? [
                    {
                      repo: demoRepos[0],
                      nameMatch: false,
                      similarName: false,
                      textRank: 1,
                      vectorRank: 1,
                      metrics: [],
                    },
                  ]
                : [],
            applied: [],
          } satisfies Search.SearchOutcome),
        ),
      ),
    }),
  );

let pageTwo: { readonly released: Promise<void>; readonly arrived: () => void } | undefined;
export const holdSecondPage = () => {
  const released = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  pageTwo = { released: released.promise, arrived: () => arrived.resolve() };
  const release = () => {
    pageTwo = undefined;
    released.resolve();
  };
  return { arrived: arrived.promise, release, [Symbol.dispose]: release };
};

const entriesOf = (id: number) =>
  (Object.values(accounts).find((account) => account.id === id)?.repos ?? []).map((each, index) => ({
    repo: each,
    starredAt: DateTime.subtract(at, { days: index }),
    stars: each.pushedAt === null ? null : 1000 * (index + 1),
    read: each.pushedAt !== null,
    gone: false,
  }));

const db = makeDb({
  // Page tests test pages, not limits, so every turn in a rate line starts at once.
  rateLines: {
    reserve: ({ line, at, cost }) =>
      Effect.succeedSome({
        line,
        cost,
        startsAt: at,
        endsAt: DateTime.addDuration(at, cost),
        generation: 1,
        released: 0,
      }),
  },
  accounts: {
    byLogin: (login: Login) => Effect.succeed(accountOf(login)),
    claimedBy: (userId) =>
      Effect.succeed(
        Option.map(
          Option.filter(signedIn(), (viewer) => viewer.userId === userId),
          (viewer) => viewer.account,
        ),
      ),
  },
  stars: {
    library: (id: number) => Effect.succeed(entriesOf(id)),
    // A hydration test can hold page two until it has checked the first page.
    page: (id: number, { after }: { after: Option.Option<unknown> }) => {
      const entries = entriesOf(id);
      const last = entries[perPage - 1];
      return Option.isNone(after)
        ? Effect.succeed({
            entries: entries.slice(0, perPage),
            next:
              last === undefined || entries.length <= perPage
                ? Option.none()
                : Option.some({ starredAt: last.starredAt, repoId: last.repo.id }),
          })
        : Effect.promise(async () => {
            const held = pageTwo;
            held?.arrived();
            await held?.released;
            return { entries: entries.slice(perPage), next: Option.none() };
          });
    },
    enrichment: (login: Login) => {
      const found = accounts[login.toLowerCase()];
      const total = found?.synced === false ? 2 : (found?.repos.length ?? 0);
      const unread = found?.repos.filter((each) => each.pushedAt === null).length ?? 0;
      return Effect.succeed({ total, read: total - unread, failed: 0, queued: 0 });
    },
  },
});

const layerWith = (search: Layer.Layer<Search.Search>) => (request: Request) =>
  Layer.mergeAll(
    search,
    syncRequests,
    Layer.succeed(Db.Db, db),
    Layer.succeed(RateLimiter, RateLimiter.of({ acquire: Effect.fn("RateLimiter.acquire")(() => Effect.void) })),
    Layer.succeed(Viewers, viewers()),
    Layer.succeed(IconHost, IconHost.of({ origin: new URL(request.url).origin })),
    Layer.succeed(Caller, Caller.of({ key: Db.CallerKey.make("caller-page"), address: "192.0.2.1" })),
  );

// The planner falls back on every query, so this API keeps no search answer.
export const serveApi = testServer(layerWith(searchWith("fallback", (query) => searched.push(query))));

const clientOf = (serve: (request: Request) => Promise<Response> | undefined): Client =>
  createORPCClient(
    new RPCLink({
      url: "/rpc",
      origin: "http://localhost",
      fetch: (url, init) => serve(new Request(url, init)) ?? Promise.resolve(new Response(null, { status: 404 })),
    }),
  );

// The browser's client, answered by the same API in this process.
export const browserClient = (): Client => clientOf(serveApi);

// An answer cache that holds the planned answer to one search, as the API stored it.
export const cacheAfter = async (input: Parameters<Client["search"]>[0]): Promise<AnswerCache.AnswerCache> => {
  const { cache } = AnswerCache.memory();
  const filling = testServer(layerWith(searchWith("model", () => {})), { answerCache: () => cache });
  await clientOf(filling).search(input);
  return cache;
};

// An answer cache that holds the demo's planned answer for q, as a search stored it minutesAgo minutes ago. That search
// ran before the page, so it records nothing in searched.
export const cacheHolding = async (q: string, minutesAgo: number): Promise<AnswerCache.AnswerCache> => {
  const cache = await cacheAfter({ scope: { kind: "stars", login: "stefanofa" }, q });
  const ago = (stored: AnswerCache.StoredAnswer) => ({ ...stored, storedAt: stored.storedAt - minutesAgo * 60_000 });
  return { ...cache, get: (key) => Effect.map(cache.get(key), Option.map(ago)) };
};
