import { describe, expect, test } from "bun:test";
import { effect } from "@stargrep/testing";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Fake from "./github.fixture.ts";
import * as GitHub from "./github.ts";
import type { BudgetShare, Login, ObjectId, RepoName, RepoNodeId } from "./schemas.ts";

const login = "octocat" as Login;

const starItem = (n: number) => ({
  starred_at: "2026-01-01T00:00:00Z",
  repo: { id: n, node_id: `R_${n}`, name: `repo-${n}`, owner: { login: "owner" }, private: false },
});

const starPages =
  (total: number): Fake.Handler =>
  (sent) => {
    const page = Number(sent.url.searchParams.get("page"));
    const first = (page - 1) * 100 + 1;
    const items = Array.from({ length: Math.max(0, Math.min(100, total - first + 1)) }, (_, i) => starItem(first + i));
    const last = Math.ceil(total / 100);
    return {
      body: items,
      headers: {
        ...Fake.rateLimitHeaders(4000),
        ...(page < last
          ? { link: `<https://api.github.com/user/1/starred?per_page=100&page=${page + 1}>; rel="next"` }
          : {}),
      },
    };
  };

const collectStars = Effect.gen(function* () {
  const github = yield* GitHub.GitHub;
  return yield* Stream.runCollect(github.stars(login));
});

const reachableStrings = (root: unknown): Array<string> => {
  const seen = new Set<unknown>();
  const strings: Array<string> = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      strings.push(value);
      return;
    }
    if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return;
    seen.add(value);
    for (let owner: object | null = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
      if (owner === Object.prototype || owner === Function.prototype) break;
      for (const key of Reflect.ownKeys(owner)) {
        try {
          visit(Reflect.get(owner, key, value));
        } catch {}
      }
    }
  };
  visit(root);
  return strings;
};

describe("stars", () => {
  effect("pages newest first until the last page", () => {
    const fake = Fake.layer(starPages(250));
    return Effect.gen(function* () {
      const stars = yield* collectStars;
      expect(stars.map((star) => star.repo.id as number)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
      expect(stars[0]?.repo).toEqual({ id: 1, nodeId: "R_1", owner: "owner", name: "repo-1" } as never);
      expect(fake.sent.map((sent) => sent.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
      const first = fake.sent[0];
      expect(first?.url.pathname).toBe("/users/octocat/starred");
      expect(first?.url.searchParams.get("per_page")).toBe("100");
      expect(first?.url.searchParams.get("direction")).toBe("desc");
      expect(first?.headers.accept).toBe("application/vnd.github.star+json");
      expect(first?.headers.authorization).toBe(`Bearer ${Fake.token}`);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("returns an empty list for an account with no stars", () => {
    const fake = Fake.layer(() => ({ body: [], headers: Fake.rateLimitHeaders(4000) }));
    return Effect.gen(function* () {
      expect(yield* collectStars).toEqual([]);
      expect(fake.sent).toHaveLength(1);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("reads one page when a sync stops at the first known star", () => {
    const fake = Fake.layer(starPages(250));
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const known = new Set([6, 7, 8]);
      const fresh = yield* Stream.runCollect(
        github.stars(login).pipe(Stream.takeWhile((star) => !known.has(star.repo.id))),
      );
      expect(fresh.map((star) => star.repo.id as number)).toEqual([1, 2, 3, 4, 5]);
      expect(fake.sent).toHaveLength(1);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("fails with NotFound for an unknown login", () => {
    const fake = Fake.layer(() => ({ status: 404, body: { message: "Not Found" } }));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(collectStars);
      expect(error).toMatchObject({ _tag: "NotFound", operation: "list-stars", path: "/users/octocat/starred" });
    }).pipe(Effect.provide(fake.layer));
  });

  effect("fails with Unauthorized and keeps the token out of the failure", () => {
    const fake = Fake.layer(() => ({ status: 401, body: { message: "Bad credentials" } }));
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(collectStars);
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("Unauthorized");
      expect(fake.sent).toHaveLength(1);
    }).pipe(Effect.provide(fake.layer));
  });

  const marker = "BODY_MARKER_SECRET_PAYLOAD";
  const leaks: ReadonlyArray<readonly [string, Fake.Handler, string]> = [
    ["an unexpected status", () => ({ status: 422, body: { message: marker } }), "GitHubRequestFailed"],
    [
      "a body that does not decode",
      () => ({ body: [{ ...starItem(1), repo: { ...starItem(1).repo, id: marker } }] }),
      "GitHubResponseInvalid",
    ],
    ["a rejected token", () => ({ status: 401, body: { message: marker } }), "Unauthorized"],
  ];
  for (const [name, handler, tag] of leaks) {
    effect(`keeps the token and the body out of every property of the failure on ${name}`, () => {
      const fake = Fake.layer(handler);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(collectStars);
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ _tag: tag });
        const strings = reachableStrings(exit);
        expect(strings.filter((value) => value.includes(Fake.token))).toEqual([]);
        expect(strings.filter((value) => value.includes(marker))).toEqual([]);
      }).pipe(Effect.provide(fake.layer));
    });
  }

  test("reachableStrings finds a bearer token held in request headers", () => {
    const request = HttpClientRequest.get("https://api.github.com/").pipe(HttpClientRequest.bearerToken(Fake.token));
    expect(reachableStrings({ cause: { request } }).some((value) => value.includes(Fake.token))).toBe(true);
  });

  effect("fails with GitHubResponseInvalid on a next link that is not a URL", () => {
    const fake = Fake.layer(() => ({
      body: [starItem(1)],
      headers: { ...Fake.rateLimitHeaders(4000), link: `<not a url>; rel="next"` },
    }));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(collectStars);
      expect(error).toMatchObject({ _tag: "GitHubResponseInvalid", operation: "list-stars", reason: "invalid-link" });
      expect(fake.sent).toHaveLength(1);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("fails with GitHubResponseInvalid on a body that does not decode, without retrying", () => {
    const fake = Fake.layer(() => ({ body: [{ starred_at: "yesterday", repo: {} }] }));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(collectStars);
      expect(error._tag).toBe("GitHubResponseInvalid");
      expect(fake.sent).toHaveLength(1);
    }).pipe(Effect.provide(fake.layer));
  });
});

describe("rate limits", () => {
  effect("waits until x-ratelimit-reset on a primary rate limit, then retries", () => {
    const fake = Fake.layer((sent, index) =>
      index === 0 ? { status: 403, headers: Fake.rateLimitHeaders(0, 30) } : starPages(1)(sent, index),
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(collectStars);
      yield* TestClock.adjust("29 seconds");
      expect(fake.sent).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toHaveLength(1);
      expect(fake.sent.map((sent) => sent.startedAt)).toEqual([0, 30_000]);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("waits for Retry-After on a secondary rate limit", () => {
    const fake = Fake.layer((sent, index) =>
      index === 0 ? { status: 429, headers: { "retry-after": "5" } } : starPages(1)(sent, index),
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(collectStars);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toHaveLength(1);
      expect(fake.sent.map((sent) => sent.startedAt)).toEqual([0, 5_000]);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("fails with RateLimited when the reset is too far away to wait for", () => {
    const fake = Fake.layer(() => ({ status: 403, headers: Fake.rateLimitHeaders(0, 1800) }));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(collectStars);
      expect(error).toMatchObject({ _tag: "RateLimited", resource: "core", retryAfterMillis: 1_800_000 });
      expect(fake.sent).toHaveLength(1);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("gives up after three retries", () => {
    const fake = Fake.layer(() => ({ status: 502 }));
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(collectStars));
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "GitHubRequestFailed", status: 502 });
      expect(fake.sent).toHaveLength(4);
    }).pipe(Effect.provide(fake.layer));
  });
});

describe("token budget", () => {
  effect("stops with TokenBudgetExhausted before the share is spent", () => {
    let remaining = 100;
    const fake = Fake.layer(
      (sent) => ({
        body: [starItem(Number(sent.url.searchParams.get("page")))],
        headers: {
          ...Fake.rateLimitHeaders(--remaining),
          link: `<https://api.github.com/user/1/starred?page=${Number(sent.url.searchParams.get("page")) + 1}>; rel="next"`,
        },
      }),
      0.1 as BudgetShare,
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(collectStars);
      expect(error).toMatchObject({ _tag: "TokenBudgetExhausted", resource: "core", resetAt: 3_600_000 });
      expect(fake.sent).toHaveLength(10);
    }).pipe(Effect.provide(fake.layer));
  });
});

const node = (n: number) => ({
  databaseId: n,
  id: `R_${n}`,
  name: `repo-${n}`,
  owner: { login: "owner" },
  description: null,
  homepageUrl: "",
  primaryLanguage: { name: "TypeScript" },
  licenseInfo: n % 2 === 0 ? null : { spdxId: "MIT" },
  repositoryTopics: { nodes: [{ topic: { name: "effect" } }] },
  createdAt: "2020-01-01T00:00:00Z",
  pushedAt: null,
  isArchived: false,
  isFork: false,
  stargazerCount: 10,
  forkCount: 1,
  root:
    n % 3 === 0
      ? null
      : {
          entries: [
            { name: "README", type: "blob", oid: "1".repeat(40) },
            { name: "readme.md", type: "blob", oid: "2".repeat(40) },
            { name: "src", type: "tree", oid: "3".repeat(40) },
          ],
        },
});

const graphqlIds = (sent: Fake.Sent): ReadonlyArray<string> => JSON.parse(sent.body ?? "{}").variables.ids;

describe("repoFacts", () => {
  effect("batches 25 node IDs per query and skips repos that are gone", () => {
    const fake = Fake.layer((sent) => {
      const ids = graphqlIds(sent);
      return {
        headers: Fake.rateLimitHeaders(4000, 3600, "graphql"),
        body: {
          data: { nodes: ids.map((id) => (id === "R_7" ? null : node(Number(id.slice(2))))) },
          errors: ids.includes("R_7") ? [{ type: "NOT_FOUND", path: ["nodes", 6], message: "gone" }] : undefined,
        },
      };
    });
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const ids = Array.from({ length: 60 }, (_, i) => `R_${i + 1}` as RepoNodeId);
      const facts = yield* github.repoFacts(ids);
      expect(fake.sent.map((sent) => graphqlIds(sent).length)).toEqual([25, 25, 10]);
      expect(fake.sent[0]?.url.pathname).toBe("/graphql");
      expect(facts).toHaveLength(59);
      expect(facts.find((fact) => fact.id === 7)).toBeUndefined();
      expect(facts[0]).toMatchObject({
        id: 1,
        nodeId: "R_1",
        license: "MIT",
        homepage: null,
        language: "TypeScript",
        topics: ["effect"],
        readme: { name: "readme.md", oid: "2".repeat(40) },
      });
      expect(facts[1]?.license).toBeNull();
      expect(facts[2]?.readme).toBeNull();
    }).pipe(Effect.provide(fake.layer));
  });

  effect("retries a RATE_LIMITED GraphQL error", () => {
    const fake = Fake.layer((sent, index) =>
      index === 0
        ? {
            headers: Fake.rateLimitHeaders(0, 10, "graphql"),
            body: { data: null, errors: [{ type: "RATE_LIMITED", message: "slow down" }] },
          }
        : {
            headers: Fake.rateLimitHeaders(4000, 3600, "graphql"),
            body: { data: { nodes: graphqlIds(sent).map((id) => node(Number(id.slice(2)))) } },
          },
    );
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const fiber = yield* Effect.forkChild(github.repoFacts(["R_1" as RepoNodeId]));
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toHaveLength(1);
      expect(fake.sent).toHaveLength(2);
    }).pipe(Effect.provide(fake.layer));
  });
});

describe("readme", () => {
  effect("serves the second fetch from the ETag", () => {
    const oid = "a".repeat(40) as ObjectId;
    const fake = Fake.layer((sent) =>
      sent.headers["if-none-match"] === `"blob"`
        ? { status: 304, headers: Fake.rateLimitHeaders(4000) }
        : { body: "# Hello", headers: { ...Fake.rateLimitHeaders(3999), etag: `"blob"` } },
    );
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const input = { owner: "owner" as Login, name: "repo" as RepoName, oid };
      expect(yield* github.readme(input)).toBe("# Hello");
      expect(yield* github.readme(input)).toBe("# Hello");
      expect(fake.sent.map((sent) => sent.url.pathname)).toEqual([
        `/repos/owner/repo/git/blobs/${oid}`,
        `/repos/owner/repo/git/blobs/${oid}`,
      ]);
      expect(fake.sent[0]?.headers.accept).toBe("application/vnd.github.raw+json");
      expect(fake.sent[1]?.headers["if-none-match"]).toBe(`"blob"`);
    }).pipe(Effect.provide(fake.layer));
  });
});
