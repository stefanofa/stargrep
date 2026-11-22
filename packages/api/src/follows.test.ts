import { expect } from "bun:test";
import { createRouterClient, ORPCError } from "@orpc/server";
import * as Analytics from "@stargrep/analytics/analytics";
import { Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { UserId } from "@stargrep/db/auth-schema";
import type { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import { accountRow } from "@stargrep/db/testing";
import type { Followed } from "@stargrep/github/following-list";
import { GitHubAccountId, Login, RepoId, RepoName } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as AnswerCache from "./answer-cache.ts";
import { Caller } from "./caller.ts";
import { GitHubLogin } from "./contract.ts";
import { IconHost } from "./icon-host.ts";
import { RateLimiter } from "./rate-limiter.ts";
import { type ApiContext, router } from "./router.ts";
import type { ApiServices } from "./services.ts";
import { NotSignedIn, type Viewer, Viewers, ViewerUnavailable } from "./viewers.ts";

const now = DateTime.makeUnsafe("2026-11-22T12:00:00Z");
const daysAgo = (days: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(now) - days * 86_400_000));

const viewerOf = (id: number, login: string): Viewer => ({
  userId: UserId.make(`user-${login}`),
  account: accountRow(GitHubAccountId.make(id), { login: Login.make(login), claimedBy: UserId.make(`user-${login}`) }),
});

const ada = viewerOf(1, "ada");
const grace = viewerOf(2, "grace");

interface Session {
  readonly viewer: Option.Option<Viewer>;
  readonly github?: Effect.Effect<ReadonlyArray<Followed>, ViewerUnavailable>;
  readonly answers?: AnswerCache.AnswerCache;
  readonly resHeaders?: Headers;
}

const unused = Effect.die(new Error("not used by follows"));

const apiFor = Effect.fnUntraced(function* (session: Session) {
  const real = yield* Effect.context<Db.Db>();
  const services: Context.Context<ApiServices> = Context.make(
    Viewers,
    Viewers.of({
      current: Effect.fromOption(session.viewer).pipe(Effect.mapError(() => new NotSignedIn())),
      githubFollowing: session.github ?? unused,
      signedIn: Effect.succeed(Option.map(session.viewer, (viewer) => viewer.userId)),
    }),
  ).pipe(
    Context.add(Search.Search, Search.Search.of({ search: () => unused })),
    Context.add(
      SyncRequests.SyncRequests,
      SyncRequests.SyncRequests.of({ request: () => unused, status: () => unused }),
    ),
    Context.add(RateLimiter, RateLimiter.of({ acquire: () => Effect.void })),
    Context.add(IconHost, IconHost.of({ origin: "https://stargrep.test" })),
    Context.add(Caller, Caller.of({ key: Db.CallerKey.make("caller-test"), address: "192.0.2.1" })),
    Context.merge(real),
  );
  const context: ApiContext = {
    "effect/context": yield* Effect.context<never>(),
    transport: "rpc",
    publicConfig: {
      demoLogin: GitHubLogin.make("ada"),
      demoQuery: "terminal dashboards",
      examples: [],
      featured: [],
      curated: [],
    },
    procedureTime: Ref.makeUnsafe(Option.none()),
    serviceLayer: Layer.succeedContext(services),
    execution: "request",
    answerCache: session.answers ?? AnswerCache.disabled,
    ...(session.resHeaders === undefined ? {} : { resHeaders: session.resHeaders }),
    background: (run) => run,
  };
  return createRouterClient(router, { context });
});

const logins = (answer: unknown) =>
  typeof answer === "string"
    ? answer
    : (answer as { follows: ReadonlyArray<{ login: string }> }).follows.map((follow) => follow.login);

type Api = Effect.Success<ReturnType<typeof apiFor>>;

const call = <A>(run: () => Promise<A>) =>
  Effect.promise(() =>
    run().then(
      (value) => value,
      (error: unknown) => {
        if (error instanceof ORPCError) return error.code as string;
        throw error;
      },
    ),
  );

interface Person {
  readonly id: number;
  readonly login: string;
  readonly type?: "user" | "org";
  readonly followers?: number;
  readonly synced?: string | null;
  readonly checked?: string;
  readonly stars?: ReadonlyArray<readonly [number, string]>;
}

const seed = Effect.fn("seed")(function* (people: ReadonlyArray<Person>) {
  const db = yield* Db.Db;
  yield* TestClock.setTime(DateTime.toEpochMillis(now));
  for (const person of people) {
    const id = GitHubAccountId.make(person.id);
    yield* db.accounts.upsert({
      id,
      type: person.type ?? "user",
      login: Login.make(person.login),
      name: null,
      avatarUrl: `https://avatars.test/${person.login}`,
      followers: person.followers ?? null,
      publicRepos: null,
    });
    for (const [repo] of person.stars ?? [])
      yield* db.repos.saveFacts({
        id: RepoId.make(repo),
        owner: Login.make("owner"),
        name: RepoName.make(`repo-${repo}`),
        description: null,
        topics: [],
        language: null,
        license: null,
        homepage: null,
        createdAt: null,
        pushedAt: null,
        archived: false,
        readmeOid: null,
        ownerType: null,
        ownerAvatarUrl: null,
      });
    if (person.stars !== undefined)
      yield* db.stars.upsert({
        accountId: id,
        stars: person.stars.map(([repo, starredAt]) => ({
          repoId: RepoId.make(repo),
          starredAt: DateTime.makeUnsafe(starredAt),
          observedAt: DateTime.makeUnsafe(starredAt),
          source: "api" as const,
        })),
      });
    const synced = person.synced === undefined ? daysAgo(0.5) : person.synced;
    if (synced !== null) yield* db.accounts.recordStarSync({ accountId: id, at: DateTime.makeUnsafe(synced) });
  }
});

const reset = Effect.flatMap(TestDatabase.TestDatabase, (database) =>
  database.query("truncate github_accounts, repos, rate_lines cascade"),
);

const people: ReadonlyArray<Person> = [
  { id: 1, login: "ada", stars: [[100, daysAgo(40)]] },
  { id: 2, login: "grace" },
  { id: 3, login: "linus", followers: 900 },
  { id: 4, login: "guido", followers: 50 },
  { id: 5, login: "vercel", type: "org" },
  { id: 6, login: "arriving", synced: null },
];

it.layer(TestDatabase.layerMemory({ embeddingModel: "test/model" as EmbeddingModelId }), { timeout: 30_000 })(
  "follows",
  (it) => {
    it.effect("tells every cache to store no signed-in answer, an error included", () =>
      Effect.gen(function* () {
        yield* reset;
        yield* seed(people);
        const policyOf = Effect.fnUntraced(function* (
          viewer: Option.Option<Viewer>,
          ask: (api: Api) => Promise<unknown>,
        ) {
          const resHeaders = new Headers();
          const api = yield* apiFor({ viewer, resHeaders });
          yield* call(() => ask(api));
          return resHeaders.get("cache-control");
        });
        const asks: ReadonlyArray<(api: Api) => Promise<unknown>> = [
          (api) => api.followedLogins(),
          (api) => api.followingFeed(),
          (api) => api.followedPeople(),
          (api) => api.followedStarrers({ id: 100 as RepoId, login: "ada" }),
          (api) => api.viewer(),
        ];
        for (const ask of asks) {
          expect(yield* policyOf(Option.none(), ask)).toBe("private, no-store");
          expect(yield* policyOf(Option.some(ada), ask)).toBe("private, no-store");
        }
        expect(yield* policyOf(Option.some(ada), (api) => api.config())).toBe("public, max-age=300");
      }),
    );

    it.effect("asks for a session on every follows procedure", () =>
      Effect.gen(function* () {
        yield* reset;
        const api = yield* apiFor({ viewer: Option.none() });
        const answers = [
          yield* call(() => api.follow({ logins: ["linus"] })),
          yield* call(() => api.unfollow({ login: "linus" })),
          yield* call(() => api.followedLogins()),
          yield* call(() => api.followedPeople()),
          yield* call(() => api.followingFeed()),
          yield* call(() => api.githubFollowing()),
          yield* call(() => api.followedStarrers({ id: 100 as RepoId, login: "ada" })),
        ];
        expect(answers).toEqual(Array(7).fill("UNAUTHORIZED"));
      }),
    );

    it.effect("follows users, never the viewer or an org, unfollows, and sends one event per change", () => {
      const events = Analytics.layerMemory();
      return Effect.gen(function* () {
        yield* reset;
        yield* seed(people);
        const api = yield* apiFor({ viewer: Option.some(ada) });
        expect(yield* call(() => api.follow({ logins: ["Linus", "ada", "vercel", "nobody", "guido"] }))).toEqual({
          following: ["linus", "guido"],
          total: 2,
          full: false,
        });
        expect(yield* call(() => api.follow({ logins: ["linus"] }))).toMatchObject({ following: ["linus"], total: 2 });
        expect(logins(yield* call(() => api.followedLogins()))).toEqual(["linus", "guido"]);
        expect(yield* call(() => api.unfollow({ login: "guido" }))).toEqual({ unfollowed: true });
        expect(yield* call(() => api.unfollow({ login: "guido" }))).toEqual({ unfollowed: false });
        expect(logins(yield* call(() => api.followedLogins()))).toEqual(["linus"]);

        const user = Analytics.Actor.User({ userId: ada.userId });
        expect(events.captured.map(({ actor, event }) => ({ actor, event }))).toEqual([
          { actor: user, event: Analytics.Event.Followed({ added: 2, source: "stargrep", following: 2 }) },
          { actor: user, event: Analytics.Event.Unfollowed() },
        ]);
        expect(JSON.stringify(events.captured)).not.toContain("linus");
      }).pipe(Effect.provide(events.layer));
    });

    it.effect("nobody reads another account's follows, and no follows answer goes in the answer cache", () =>
      Effect.gen(function* () {
        yield* reset;
        yield* seed([...people, { id: 7, login: "rich", stars: [[200, daysAgo(1)]] }]);
        const answers = AnswerCache.memory();
        const adaApi = yield* apiFor({ viewer: Option.some(ada), answers: answers.cache });
        const graceApi = yield* apiFor({ viewer: Option.some(grace), answers: answers.cache });
        yield* call(() => adaApi.follow({ logins: ["rich", "linus"] }));

        expect(yield* call(() => graceApi.followedLogins())).toEqual({ follows: [] });
        expect(yield* call(() => graceApi.followedPeople())).toEqual({ people: [] });
        expect(yield* call(() => graceApi.followingFeed())).toMatchObject({ following: 0, repos: [], lastStar: null });
        expect(yield* call(() => graceApi.followedStarrers({ id: 200 as RepoId, login: "grace" }))).toEqual({
          people: [],
          total: 0,
        });
        expect(yield* call(() => graceApi.unfollow({ login: "rich" }))).toEqual({ unfollowed: false });

        expect(yield* call(() => adaApi.followedStarrers({ id: 200 as RepoId, login: "ada" }))).toEqual({
          people: [{ login: "rich", avatarUrl: "https://avatars.test/rich" }],
          total: 1,
        });
        expect(yield* call(() => adaApi.followedStarrers({ id: 200 as RepoId, login: "rich" }))).toEqual({
          people: [],
          total: 0,
        });
        expect((yield* call(() => adaApi.followingFeed())) as { repos: ReadonlyArray<unknown> }).toMatchObject({
          following: 2,
          repos: [{ id: 200 }],
        });
        expect(answers.entries.size).toBe(0);
      }),
    );

    it.effect("takes 60 follows or unfollows an hour from an account, then one a minute", () =>
      Effect.gen(function* () {
        yield* reset;
        yield* seed(people);
        const api = yield* apiFor({ viewer: Option.some(ada) });
        const graceApi = yield* apiFor({ viewer: Option.some(grace) });
        const turns = yield* Effect.forEach(Array.from({ length: 30 }), () =>
          Effect.zip(
            call(() => api.follow({ logins: ["linus"] })),
            call(() => api.unfollow({ login: "linus" })),
          ),
        );
        expect(turns.flat().every((answer) => typeof answer === "object")).toBe(true);
        expect(yield* call(() => api.follow({ logins: ["linus"] }))).toBe("TOO_MANY_REQUESTS");
        expect(yield* call(() => graceApi.follow({ logins: ["linus"] }))).toMatchObject({ total: 1 });
        yield* TestClock.adjust("1 minute");
        expect(yield* call(() => api.follow({ logins: ["linus"] }))).toMatchObject({ total: 1 });
        expect(yield* call(() => api.follow({ logins: ["guido"] }))).toBe("TOO_MANY_REQUESTS");
      }),
    );

    it.effect("stops at 1,000 follows and says the cap left some out", () =>
      Effect.gen(function* () {
        yield* reset;
        yield* seed(people);
        const database = yield* TestDatabase.TestDatabase;
        yield* database.query(
          `insert into github_accounts (id, type, login) select 1000 + n, 'user', 'filler-' || n from generate_series(1, 999) n`,
        );
        yield* database.query(
          `insert into follows (follower_id, followee_id, source) select 1, 1000 + n, 'stargrep' from generate_series(1, 999) n`,
        );
        const api = yield* apiFor({ viewer: Option.some(ada) });
        expect(yield* call(() => api.follow({ logins: ["linus", "guido"] }))).toEqual({
          following: ["linus"],
          total: 1000,
          full: true,
        });
        expect(logins(yield* call(() => api.followedLogins()))).toContain("linus");
      }),
    );

    it.effect("lists the people followed with their latest star and when their stars were checked", () =>
      Effect.gen(function* () {
        yield* reset;
        yield* seed([...people, { id: 7, login: "rich", stars: [[200, daysAgo(3)]], synced: daysAgo(0.25) }]);
        const api = yield* apiFor({ viewer: Option.some(ada) });
        yield* call(() => api.follow({ logins: ["rich", "arriving"], source: "github" }));
        expect(yield* call(() => api.followedPeople())).toEqual({
          // One statement gives both follows the same time, so the account ID orders them.
          people: [
            {
              login: "arriving",
              avatarUrl: "https://avatars.test/arriving",
              source: "github",
              followedAt: expect.any(String),
              lastStarredAt: null,
              checkedAt: null,
            },
            {
              login: "rich",
              avatarUrl: "https://avatars.test/rich",
              source: "github",
              followedAt: expect.any(String),
              lastStarredAt: daysAgo(3),
              checkedAt: daysAgo(0.25),
            },
          ],
        });
      }),
    );

    it.effect("feeds one row per repo, hides the viewer's stars and anything older than 30 days", () =>
      Effect.gen(function* () {
        yield* reset;
        yield* seed([
          { id: 1, login: "ada", stars: [[300, daysAgo(60)]] },
          {
            id: 3,
            login: "linus",
            synced: daysAgo(1),
            stars: [
              [300, daysAgo(1)],
              [301, daysAgo(2)],
              [302, daysAgo(3)],
              [303, daysAgo(31)],
            ],
          },
          {
            id: 4,
            login: "guido",
            synced: daysAgo(0.1),
            stars: [
              [301, daysAgo(1.5)],
              [304, daysAgo(10)],
            ],
          },
          { id: 6, login: "arriving", synced: null },
        ]);
        const database = yield* TestDatabase.TestDatabase;
        yield* database.query("update repos set gone_at = now() where id = 304");
        const api = yield* apiFor({ viewer: Option.some(ada) });
        yield* call(() => api.follow({ logins: ["linus", "guido", "arriving"] }));
        const feed = yield* call(() => api.followingFeed());
        expect(feed).toMatchObject({
          following: 3,
          arriving: 1,
          checkedAt: daysAgo(1),
          windowDays: 30,
          avatars: { linus: "https://avatars.test/linus", guido: "https://avatars.test/guido" },
          repos: [
            {
              id: 301,
              name: "repo-301",
              starredBy: [
                { login: "guido", starredAt: daysAgo(1.5) },
                { login: "linus", starredAt: daysAgo(2) },
              ],
            },
            { id: 302, starredBy: [{ login: "linus", starredAt: daysAgo(3) }] },
          ],
          top: { id: 301, starrers: 2 },
          busiest: [
            { login: "linus", stars: 3, latestAt: daysAgo(1) },
            { login: "guido", stars: 1, latestAt: daysAgo(1.5) },
          ],
          lastStar: { login: "linus", starredAt: daysAgo(1) },
        });
        expect((feed as { repos: ReadonlyArray<unknown> }).repos.length).toBe(2);
      }),
    );

    it.effect("suggests the GitHub following Stargrep holds, once a day, and a failed read gives the day back", () =>
      Effect.gen(function* () {
        yield* reset;
        yield* seed(people);
        const fromGitHub = [
          { id: GitHubAccountId.make(4), login: Login.make("guido") },
          { id: GitHubAccountId.make(3), login: Login.make("linus") },
          { id: GitHubAccountId.make(6), login: Login.make("arriving") },
          { id: GitHubAccountId.make(99), login: Login.make("elsewhere") },
        ];
        const failing = yield* apiFor({
          viewer: Option.some(ada),
          github: Effect.fail(new ViewerUnavailable({ step: "github" })),
        });
        expect(yield* call(() => failing.githubFollowing())).toBe("SERVICE_UNAVAILABLE");

        const api = yield* apiFor({ viewer: Option.some(ada), github: Effect.succeed(fromGitHub) });
        yield* call(() => api.follow({ logins: ["guido"] }));
        expect(yield* call(() => api.githubFollowing())).toEqual({
          people: [
            { login: "linus", avatarUrl: "https://avatars.test/linus", following: false },
            { login: "guido", avatarUrl: "https://avatars.test/guido", following: true },
          ],
          notOnStargrep: 2,
        });
        expect(yield* call(() => api.githubFollowing())).toBe("TOO_MANY_REQUESTS");
        yield* TestClock.adjust("1 day");
        expect(yield* call(() => api.githubFollowing())).toMatchObject({ notOnStargrep: 2 });
      }),
    );
  },
);
