import { describe, expect, test } from "bun:test";
import * as Otlp from "@stargrep/telemetry/otlp";
import { effect } from "@stargrep/testing";
import * as Cause from "effect/Cause";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { blobOid } from "./blob-oid.ts";
import * as Fake from "./github.fixture.ts";
import * as GitHub from "./github.ts";
import { type BudgetShare, Login, ObjectId, RepoId, RepoName, type RepoNodeId } from "./schemas.ts";

const login = "octocat" as Login;

const listedAt = "2026-01-01T00:00:00Z";

const marker = "BODY_MARKER_SECRET_PAYLOAD";

const starItem = (n: number) => Fake.starItem({ repo: n, starredAt: listedAt });

const starPages =
  (total: number): Fake.Handler =>
  (sent) =>
    Fake.starPage(
      Array.from({ length: total }, (_, i) => ({ repo: i + 1, starredAt: listedAt })),
      sent,
    );

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
  effect("emits one element per page from starPages", () => {
    const fake = Fake.layer(starPages(250));
    return Effect.gen(function* () {
      const pages = yield* Stream.runCollect((yield* GitHub.GitHub).starPages(login));
      expect(pages.map((page) => page.length)).toEqual([100, 100, 50]);
      expect(pages[2]?.[0]?.repo.id as number).toBe(201);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("emits one empty page for an account with no stars", () => {
    const fake = Fake.layer(() => ({ body: [] }));
    return Effect.gen(function* () {
      const pages = yield* Stream.runCollect((yield* GitHub.GitHub).starPages(login));
      expect(pages).toEqual([[]]);
    }).pipe(Effect.provide(fake.layer));
  });

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

describe("owner", () => {
  const lookup = (body: unknown) => {
    const fake = Fake.layer(() => Fake.ownerReply(body));
    return {
      fake,
      owner: Effect.flatMap(GitHub.GitHub, (github) => github.owner(login)).pipe(Effect.provide(fake.layer)),
    };
  };

  effect("reads a user's facts and starred total in one GraphQL request", () => {
    const { fake, owner } = lookup(Fake.ownerBodies.user);
    return Effect.gen(function* () {
      expect(yield* owner).toEqual(
        Option.some({
          account: {
            id: 583231,
            login: "octocat",
            type: "user",
            name: "The Octocat",
            avatarUrl: Fake.ownerBodies.user.data.repositoryOwner.avatarUrl,
            followers: 24947,
            publicRepos: 8,
          },
          starredTotal: 3,
        }) as never,
      );
      expect(fake.sent.map((sent) => [sent.url.pathname, JSON.parse(sent.body ?? "{}").variables])).toEqual([
        ["/graphql", { login: "octocat" }],
      ]);
    });
  });

  effect("reads an org with no follower count and a starred total of 0", () => {
    const { owner } = lookup(Fake.ownerBodies.org);
    return Effect.gen(function* () {
      expect(Option.getOrThrow(yield* owner)).toEqual({
        account: {
          id: 9919,
          login: "github",
          type: "org",
          name: "GitHub",
          avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4",
          followers: null,
          publicRepos: 572,
        },
        starredTotal: 0,
      } as never);
    });
  });

  effect("answers none for a login GitHub has no user or org for", () => {
    const { owner } = lookup(Fake.ownerBodies.missing);
    return Effect.gen(function* () {
      expect(yield* owner).toEqual(Option.none());
    });
  });

  effect("fails with GitHubRequestFailed on other GraphQL errors", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.flip(lookup({ data: null, errors: [{ type: "INTERNAL", message: "boom" }] }).owner);
      expect(failed).toMatchObject({ _tag: "GitHubRequestFailed", operation: "owner", reason: "graphql-errors" });
    }),
  );

  effect("fails with GitHubResponseInvalid when the owner does not match the schema", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        lookup({ data: { repositoryOwner: { __typename: "User", login: "octocat" } } }).owner,
      );
      expect(error).toMatchObject({ _tag: "GitHubResponseInvalid", operation: "owner", reason: "schema-mismatch" });
    }),
  );
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

  const secondaryLimit = (detail: string) => ({
    status: 403,
    body: { message: `You have exceeded a secondary rate limit. ${detail}` },
    headers: Fake.rateLimitHeaders(4900, 3600),
  });

  effect("waits a minute on a secondary rate limit with quota left and no Retry-After", () => {
    const fake = Fake.layer((sent, index) =>
      index === 0 ? secondaryLimit("Please wait a few minutes.") : starPages(1)(sent, index),
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(collectStars);
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(fiber)).toHaveLength(1);
      expect(fake.sent.map((sent) => sent.startedAt)).toEqual([0, 60_000]);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("fails a secondary rate limit that persists with RateLimited and keeps its message out", () => {
    const fake = Fake.layer(() => secondaryLimit(marker));
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(collectStars));
      yield* TestClock.adjust("3 minutes");
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
        _tag: "RateLimited",
        retryAfterMillis: 60_000,
      });
      expect(fake.sent).toHaveLength(4);
      expect(reachableStrings(exit).filter((value) => value.includes(marker))).toEqual([]);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("fails a 403 that is not a rate limit with its status, without waiting", () => {
    const fake = Fake.layer(() => ({
      status: 403,
      body: { message: "Resource not accessible by personal access token" },
      headers: Fake.rateLimitHeaders(4900, 3600),
    }));
    return Effect.gen(function* () {
      const error = yield* Effect.flip(collectStars);
      expect(error).toMatchObject({ _tag: "GitHubRequestFailed", reason: "status", status: 403 });
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
  owner: { __typename: "Organization", login: "owner", avatarUrl: "https://avatars.githubusercontent.com/u/9?v=4" },
  description: null,
  homepageUrl: "",
  primaryLanguage: { name: "TypeScript" },
  licenseInfo: n % 2 === 0 ? null : { spdxId: "MIT" },
  repositoryTopics: { nodes: [{ topic: { name: "effect" } }] },
  createdAt: "2020-01-01T00:00:00Z",
  pushedAt: null,
  isArchived: false,
  isFork: false,
  isPrivate: false,
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
            { name: "favicon.ico", type: "blob", oid: "4".repeat(40) },
            { name: "logo-dark.svg", type: "blob", oid: "5".repeat(40) },
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
        iconFiles: [
          { name: "logo-dark.svg", oid: "5".repeat(40) },
          { name: "favicon.ico", oid: "4".repeat(40) },
        ],
        ownerType: "org",
        ownerAvatarUrl: "https://avatars.githubusercontent.com/u/9?v=4",
      });
      expect(facts[1]?.license).toBeNull();
      expect(facts[2]?.readme).toBeNull();
    }).pipe(Effect.provide(fake.layer));
  });

  effect("leaves out a repo the token may not read and keeps the rest of its batch", () => {
    const fake = Fake.layer((sent) => {
      const ids = graphqlIds(sent);
      return {
        headers: Fake.rateLimitHeaders(4000, 3600, "graphql"),
        body: {
          data: {
            nodes: ids.map((id) => (id === "R_5" ? null : node(Number(id.slice(2))))),
          },
          errors: [
            { type: "FORBIDDEN", path: ["nodes", 4], message: "Resource not accessible by personal access token" },
            { type: "FORBIDDEN", path: ["nodes", 4, "root"], message: "Resource not accessible" },
            { type: "FORBIDDEN", path: ["nodes", 8, "root"], message: "Resource not accessible" },
          ],
        },
      };
    });
    const logs: Array<unknown> = [];
    const capture = Logger.layer([Logger.make(({ message }) => logs.push(message))]);
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const facts = yield* github.repoFacts(Array.from({ length: 25 }, (_, i) => `R_${i + 1}` as RepoNodeId));
      expect(facts.map((fact): number => fact.id)).toEqual(
        Array.from({ length: 25 }, (_, i) => i + 1).filter((n) => n !== 5 && n !== 9),
      );
      expect(fake.sent).toHaveLength(1);
      expect(logs).toContainEqual(["GitHub forbade repos to the token", { nodeIds: ["R_5", "R_9"] }]);
    }).pipe(Effect.provide(Layer.merge(fake.layer, capture)));
  });

  effect("leaves out a repo that is private, whatever the token may read, and logs it as forbidden", () => {
    const fake = Fake.layer((sent) => ({
      headers: Fake.rateLimitHeaders(4000, 3600, "graphql"),
      body: {
        data: { nodes: graphqlIds(sent).map((id) => ({ ...node(Number(id.slice(2))), isPrivate: id === "R_2" })) },
      },
    }));
    const logs: Array<unknown> = [];
    const capture = Logger.layer([Logger.make(({ message }) => logs.push(message))]);
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const facts = yield* github.repoFacts(["R_1", "R_2", "R_3"].map((id) => id as RepoNodeId));
      expect(facts.map((fact): number => fact.id)).toEqual([1, 3]);
      expect(logs).toContainEqual(["GitHub forbade repos to the token", { nodeIds: ["R_2"] }]);
    }).pipe(Effect.provide(Layer.merge(fake.layer, capture)));
  });

  effect("keeps a repo that GitHub returned with a NOT_FOUND on one of its fields", () => {
    const fake = Fake.layer((sent) => ({
      headers: Fake.rateLimitHeaders(4000, 3600, "graphql"),
      body: {
        data: { nodes: graphqlIds(sent).map((id) => node(Number(id.slice(2)))) },
        errors: [{ type: "NOT_FOUND", path: ["nodes", 3, "root"], message: "Could not resolve to an object" }],
      },
    }));
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const facts = yield* github.repoFacts(Array.from({ length: 6 }, (_, i) => `R_${i + 1}` as RepoNodeId));
      expect(facts.map((fact): number => fact.id)).toEqual([1, 2, 3, 4, 5, 6]);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("fails the batch on a FORBIDDEN error that names no repo", () => {
    const fake = Fake.layer((sent) => ({
      headers: Fake.rateLimitHeaders(4000, 3600, "graphql"),
      body: {
        data: { nodes: graphqlIds(sent).map((id) => node(Number(id.slice(2)))) },
        errors: [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }],
      },
    }));
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const error = yield* Effect.flip(github.repoFacts(["R_1" as RepoNodeId, "R_2" as RepoNodeId]));
      expect(error).toMatchObject({ _tag: "GitHubRequestFailed", reason: "graphql-errors" });
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

const archiveRef = (n: number) => ({
  id: RepoId.make(n),
  owner: Login.make("owner"),
  name: RepoName.make(`repo-${n}`),
});

// The names a resolve query asks for, in alias order.
const resolvedNames = (sent: Fake.Sent): ReadonlyArray<string> => {
  const variables: Record<string, string> = JSON.parse(sent.body ?? "{}").variables;
  return Object.keys(variables)
    .filter((key) => key.startsWith("n"))
    .map((key) => variables[key] ?? "");
};

describe("resolveRepos", () => {
  effect("looks repos up by name 25 at a time and keeps only those whose ID is the archive's", () => {
    const fake = Fake.layer((sent) => {
      const names = resolvedNames(sent);
      const data = Object.fromEntries(
        names.map((name, index) => {
          const n = Number(name.slice("repo-".length));
          if (n === 7 || n === 8) return [`r${index}`, null];
          if (n === 31) return [`r${index}`, { ...node(31), isPrivate: true }];
          return [`r${index}`, n === 30 ? { ...node(30), databaseId: 99_030 } : node(n)];
        }),
      );
      const errors = names.flatMap((name, index) => {
        if (name === "repo-7") return [{ type: "NOT_FOUND", path: [`r${index}`], message: "Could not resolve" }];
        if (name === "repo-8") return [{ type: "FORBIDDEN", path: [`r${index}`], message: "Not accessible" }];
        if (name === "repo-12") return [{ type: "NOT_FOUND", path: [`r${index}`, "root"], message: "Empty repo" }];
        return [];
      });
      return { headers: Fake.rateLimitHeaders(4000, 3600, "graphql"), body: { data, errors } };
    });
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const { facts, unresolved } = yield* github.resolveRepos(Array.from({ length: 40 }, (_, i) => archiveRef(i + 1)));
      expect(fake.sent.map((sent) => resolvedNames(sent).length)).toEqual([25, 15]);
      expect(facts.map((fact): number => fact.id)).toEqual(
        Array.from({ length: 40 }, (_, i) => i + 1).filter((n) => ![7, 8, 30, 31].includes(n)),
      );
      expect(facts[0]).toMatchObject({ id: 1, nodeId: "R_1", owner: "owner", name: "repo-1" });
      expect(unresolved.map(({ id, reason }) => [Number(id), reason])).toEqual([
        [7, "missing"],
        [8, "forbidden"],
        [30, "other-repo"],
        [31, "forbidden"],
      ]);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("fails the batch on an error that names no alias", () => {
    const fake = Fake.layer((sent) => ({
      headers: Fake.rateLimitHeaders(4000, 3600, "graphql"),
      body: {
        data: Object.fromEntries(resolvedNames(sent).map((_, index) => [`r${index}`, node(index + 1)])),
        errors: [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }],
      },
    }));
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const error = yield* Effect.flip(github.resolveRepos([archiveRef(1), archiveRef(2)]));
      expect(error._tag).toBe("GitHubRequestFailed");
    }).pipe(Effect.provide(fake.layer));
  });
});

describe("readme", () => {
  effect("returns GraphQL rate-limit envelope text as an ordinary README", () => {
    const text = '{"errors":[{"type":"RATE_LIMITED","message":"x"}]}';
    const fake = Fake.layer(() => ({ body: text }));
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      expect(
        yield* github.readme({
          owner: Login.make("owner"),
          name: RepoName.make("repo"),
          oid: ObjectId.make("a".repeat(40)),
        }),
      ).toBe(text);
      expect(fake.sent).toHaveLength(1);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("fetches the blob by object id as raw text, with no conditional header", () => {
    const oid = "a".repeat(40) as ObjectId;
    const fake = Fake.layer(() => ({ body: "# Hello", headers: { ...Fake.rateLimitHeaders(3999), etag: `"blob"` } }));
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      expect(yield* github.readme({ owner: "owner" as Login, name: "repo" as RepoName, oid })).toBe("# Hello");
      expect(fake.sent.map((sent) => sent.url.pathname)).toEqual([`/repos/owner/repo/git/blobs/${oid}`]);
      expect(fake.sent[0]?.headers.accept).toBe("application/vnd.github.raw+json");
      expect(fake.sent[0]?.headers["if-none-match"]).toBeUndefined();
    }).pipe(Effect.provide(fake.layer));
  });
});

// One repo's README as GitHub holds it, and what its GraphQL batch alias answers.
interface Held {
  readonly text: string;
  readonly answer?: "text" | "repo-gone" | "forbidden" | "blob-gone" | "cut-short";
}

const oidOf = (text: string) =>
  Effect.map(blobOid(new TextEncoder().encode(text)), ObjectId.make).pipe(Effect.provide(Digest.layerWebCrypto));

// Answers README batches by node ID and object ID, and REST blob reads by object ID, from the repos GitHub holds.
const readmeHandler =
  (held: ReadonlyMap<string, Held & { readonly oid: ObjectId }>): Fake.Handler =>
  (sent) => {
    if (sent.url.pathname !== "/graphql") {
      const found = [...held.values()].find((entry) => sent.url.pathname.endsWith(`/git/blobs/${entry.oid}`));
      return found === undefined ? { status: 404 } : { body: found.text, headers: Fake.rateLimitHeaders(4000) };
    }
    const variables: Record<string, string> = JSON.parse(sent.body ?? "{}").variables;
    const data: Record<string, unknown> = {};
    const errors: Array<unknown> = [];
    for (let index = 0; `r${index}` in variables; index++) {
      const entry = held.get(variables[`r${index}`] ?? "");
      const answer = entry?.answer ?? "text";
      if (entry === undefined || entry.oid !== variables[`o${index}`]) data[`b${index}`] = { object: null };
      else if (answer === "repo-gone" || answer === "forbidden") {
        data[`b${index}`] = null;
        const type = answer === "repo-gone" ? "NOT_FOUND" : "FORBIDDEN";
        errors.push({ type, path: [`b${index}`], message: "Could not resolve" });
      } else if (answer === "blob-gone") data[`b${index}`] = { object: null };
      else data[`b${index}`] = { object: { text: answer === "cut-short" ? entry.text.slice(0, 8) : entry.text } };
    }
    return { headers: Fake.rateLimitHeaders(4000, 3600, "graphql"), body: { data, errors } };
  };

const holding = Effect.fn("test.holding")(function* (entries: ReadonlyArray<readonly [string, Held]>) {
  const held = new Map<string, Held & { readonly oid: ObjectId }>();
  for (const [nodeId, entry] of entries) held.set(nodeId, { ...entry, oid: yield* oidOf(entry.text) });
  return held;
});

const refOf = (held: ReadonlyMap<string, { readonly oid: ObjectId }>, nodeId: string) => ({
  nodeId: nodeId as RepoNodeId,
  oid: held.get(nodeId)?.oid ?? ObjectId.make("0".repeat(40)),
});

describe("readmes", () => {
  effect("reads READMEs 25 to a request and keeps only text that hashes to the object ID asked for", () =>
    Effect.gen(function* () {
      const answers: Record<number, Held["answer"]> = {
        27: "repo-gone",
        28: "blob-gone",
        29: "forbidden",
        30: "cut-short",
      };
      const held = yield* holding(
        Array.from({ length: 30 }, (_, i) => [
          `R_${i + 1}`,
          { text: `# repo-${i + 1}\n\nA CLI.`, answer: answers[i + 1] ?? "text" },
        ]),
      );
      const fake = Fake.layer(readmeHandler(held));
      const refs = [...held.keys()].map((nodeId) => refOf(held, nodeId));
      // A fork that keeps its parent's README asks for the same blob, so it is read once.
      const fork = { nodeId: "R_31" as RepoNodeId, oid: refs[0]?.oid ?? ObjectId.make("0".repeat(40)) };
      const texts = yield* Effect.flatMap(GitHub.GitHub, (github) => github.readmes([...refs, fork])).pipe(
        Effect.provide(fake.layer),
      );
      expect([...texts.values()]).toEqual(Array.from({ length: 26 }, (_, i) => `# repo-${i + 1}\n\nA CLI.`));
      expect([...texts.keys()]).toEqual(refs.slice(0, 26).map((ref) => ref.oid));
      expect(
        fake.sent.map((sent) => {
          const variables: Record<string, string> = JSON.parse(sent.body ?? "{}").variables;
          return [sent.url.pathname, Object.keys(variables).length / 2, variables.r0, variables.o0];
        }),
      ).toEqual([
        ["/graphql", 25, "R_1", refs[0]?.oid],
        ["/graphql", 5, "R_26", refs[25]?.oid],
      ]);
    }),
  );

  effect("returns the string a REST read returns, with a leading byte order mark dropped", () =>
    Effect.gen(function* () {
      const held = yield* holding([
        ["R_1", { text: "\uFEFF# Bom\n\nSaved by Notepad." }],
        ["R_2", { text: "# Crlf\r\n\r\nWindows line endings.\r\n" }],
        ["R_3", { text: "# Ünïcödé 🚀\n\n日本語のドキュメント  \n" }],
      ]);
      const fake = Fake.layer(readmeHandler(held));
      yield* Effect.gen(function* () {
        const github = yield* GitHub.GitHub;
        const batched = yield* github.readmes([...held.keys()].map((nodeId) => refOf(held, nodeId)));
        const rest = yield* Effect.forEach([...held.values()], (entry) =>
          github.readme({ owner: Login.make("owner"), name: RepoName.make("repo"), oid: entry.oid }),
        );
        expect([...batched.values()]).toEqual(rest);
        expect(rest[0]).toBe("# Bom\n\nSaved by Notepad.");
      }).pipe(Effect.provide(fake.layer));
    }),
  );

  effect("leaves every README of a batch GitHub failed to answer to REST", () =>
    Effect.gen(function* () {
      const held = yield* holding([["R_1", { text: "# One" }]]);
      const replies: ReadonlyArray<Fake.Reply> = [
        { body: { data: null, errors: [{ type: "MAX_NODE_LIMIT_EXCEEDED", message: "Too many" }] } },
        { body: { data: { nodes: [] } } },
        { status: 502 },
      ];
      for (const reply of replies) {
        const fake = Fake.layer(() => reply);
        const texts = yield* Effect.gen(function* () {
          const github = yield* GitHub.GitHub;
          const fiber = yield* Effect.forkChild(github.readmes([refOf(held, "R_1")]));
          yield* TestClock.adjust("1 minute");
          return yield* Fiber.join(fiber);
        }).pipe(Effect.provide(fake.layer));
        expect(texts.size).toBe(0);
      }
    }),
  );

  effect("waits out a short GraphQL rate limit on a batch", () =>
    Effect.gen(function* () {
      const held = yield* holding([["R_1", { text: "# One" }]]);
      const answer = readmeHandler(held);
      const fake = Fake.layer((sent, index) =>
        index === 0
          ? {
              headers: Fake.rateLimitHeaders(0, 30, "graphql"),
              body: { data: null, errors: [{ type: "RATE_LIMITED", message: "slow down" }] },
            }
          : answer(sent, index),
      );
      const texts = yield* Effect.gen(function* () {
        const github = yield* GitHub.GitHub;
        const fiber = yield* Effect.forkChild(github.readmes([refOf(held, "R_1")]));
        yield* TestClock.adjust("30 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(fake.layer));
      expect([...texts.values()]).toEqual(["# One"]);
      expect(fake.sent.map((sent) => sent.startedAt)).toEqual([0, 30_000]);
    }),
  );

  effect("fails on a long GraphQL rate limit rather than spend REST requests while limited", () =>
    Effect.gen(function* () {
      const held = yield* holding([["R_1", { text: "# One" }]]);
      const fake = Fake.layer(() => ({
        headers: Fake.rateLimitHeaders(0, 600, "graphql"),
        body: { data: null, errors: [{ type: "RATE_LIMITED", message: "slow down" }] },
      }));
      const error = yield* Effect.flatMap(GitHub.GitHub, (github) =>
        Effect.flip(github.readmes([refOf(held, "R_1")])),
      ).pipe(Effect.provide(fake.layer));
      expect(error).toMatchObject({ _tag: "RateLimited", resource: "graphql", retryAfterMillis: 600_000 });
      expect(fake.sent).toHaveLength(1);
    }),
  );
});

describe("telemetry", () => {
  effect("logs only bounded GraphQL error types", () => {
    const logs: Array<unknown> = [];
    const fake = Fake.layer(() => ({
      headers: Fake.rateLimitHeaders(4000, 3600, "graphql"),
      body: {
        data: null,
        errors: [
          { type: `${marker} ${Fake.token}`, message: `${marker} ${Fake.token}` },
          { type: "FORBIDDEN", message: marker },
        ],
      },
    }));
    const capture = Logger.layer([Logger.make(({ message }) => logs.push(message))]);
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const error = yield* Effect.flip(github.repoFacts(["R_1" as RepoNodeId]));
      expect(error).toMatchObject({ _tag: "GitHubRequestFailed", reason: "graphql-errors" });
      const strings = reachableStrings(logs);
      expect(strings.filter((value) => value.includes(Fake.token) || value.includes(marker))).toEqual([]);
      expect(logs).toContainEqual(["GitHub GraphQL errors", { count: 2, types: ["FORBIDDEN"] }]);
    }).pipe(Effect.provide(Layer.merge(fake.layer, capture)));
  });

  effect("exports only bounded errors in spans when a transport failure carries secrets", () => {
    const payloads: Array<string> = [];
    const collector = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag === "Uint8Array") payloads.push(new TextDecoder().decode(request.body.body));
        return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
      }),
    );
    const otlp = Otlp.layer({
      url: "https://collector.invalid/v1/traces",
      resource: { serviceName: "github-test" },
      exportInterval: "1 hour",
    }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(Layer.succeed(HttpClient.HttpClient, collector)));
    const fake = Fake.layer(() => ({ transportError: `${Fake.token} ${marker}` }));
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(collectStars));
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "GitHubRequestFailed", reason: "transport" });
      yield* (yield* OtlpExporter.Flusher).flush;
      const exported = payloads.join("\n");
      expect(exported).toContain("TokenGate.execute");
      expect(exported).not.toContain(Fake.token);
      expect(exported).not.toContain(marker);
    }).pipe(Effect.provide(Layer.merge(fake.layer, otlp)));
  });
});

describe("reply boundaries", () => {
  const terminal: ReadonlyArray<readonly [number, Record<string, unknown>]> = [
    [401, { _tag: "Unauthorized" }],
    [404, { _tag: "NotFound" }],
    [422, { _tag: "GitHubRequestFailed", reason: "status", status: 422 }],
  ];
  for (const [status, expected] of terminal) {
    effect(`keeps a ${status} when its body cannot be read, without reading it or retrying`, () => {
      const fake = Fake.layer(() => ({ status, stream: "broken" }));
      return Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.flip(collectStars));
        yield* TestClock.adjust("1 minute");
        expect(yield* Fiber.join(fiber)).toMatchObject(expected);
        expect(fake.sent).toHaveLength(1);
        expect(fake.reads.count).toBe(0);
      }).pipe(Effect.provide(fake.layer));
    });
  }

  effect("fails a 200 whose body breaks with unreadable-body, without retrying", () => {
    const fake = Fake.layer(() => ({ stream: "broken" }));
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(collectStars));
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "GitHubResponseInvalid", reason: "unreadable-body" });
      expect(fake.sent).toHaveLength(1);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("counts an exhausted budget from headers that arrived before the body timed out", () => {
    const fake = Fake.layer(() => ({ stream: "hang", headers: Fake.rateLimitHeaders(0) }));
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(collectStars));
      yield* TestClock.adjust("3 minutes");
      expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "TokenBudgetExhausted", resource: "core" });
      expect(fake.sent).toHaveLength(1);
    }).pipe(Effect.provide(fake.layer));
  });

  const partial = (resource: string) => ({
    "x-ratelimit-resource": resource,
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": "5",
  });

  effect("honors a reset on a REST 403 without x-ratelimit-limit", () => {
    const fake = Fake.layer((_, index) => (index === 0 ? { status: 403, headers: partial("core") } : { body: [] }));
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(collectStars);
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(fiber)).toEqual([]);
      expect(fake.sent.map((sent) => sent.startedAt)).toEqual([0, 5_000]);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("honors a reset on a GraphQL RATE_LIMITED without x-ratelimit-limit", () => {
    const fake = Fake.layer((_, index) =>
      index === 0
        ? { headers: partial("graphql"), body: { data: null, errors: [{ type: "RATE_LIMITED", message: "slow" }] } }
        : { body: { data: { nodes: [] } } },
    );
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const fiber = yield* Effect.forkChild(github.repoFacts(["R_1" as RepoNodeId]));
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(fiber)).toEqual([]);
      expect(fake.sent.map((sent) => sent.startedAt)).toEqual([0, 5_000]);
    }).pipe(Effect.provide(fake.layer));
  });
});
