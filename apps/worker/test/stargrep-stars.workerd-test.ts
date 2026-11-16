import { TokenBudgetExhausted } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import * as GitHubFake from "@stargrep/github/github.fixture";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { stargrepStars } from "../src/stargrep-stars.ts";

const stargrepNode = (overrides: Record<string, unknown> = {}) => ({
  databaseId: 1444651825,
  id: "R_kgDOVhujMQ",
  name: "stargrep",
  owner: { __typename: "User", login: "stefanofa", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
  description: null,
  homepageUrl: null,
  primaryLanguage: { name: "TypeScript" },
  licenseInfo: null,
  repositoryTopics: { nodes: [] },
  createdAt: "2026-01-01T00:00:00Z",
  pushedAt: null,
  isArchived: false,
  isFork: false,
  isPrivate: false,
  stargazerCount: 128,
  forkCount: 3,
  root: null,
  ...overrides,
});

const replying = (node: unknown, errors: ReadonlyArray<unknown> = []) => {
  const fake = GitHubFake.layer(() => ({
    headers: GitHubFake.rateLimitHeaders(4000, 3600, "graphql"),
    body: { data: { r0: node }, errors },
  }));
  return { fake, read: stargrepStars(fake.layer) };
};

const overGate = (gate: Layer.Layer<TokenGate.TokenGate>) => stargrepStars(GitHub.layer.pipe(Layer.provide(gate)));

describe("stargrepStars", () => {
  it("reads Stargrep's own repo with the server's token, by name and ID", async () => {
    const { fake, read } = replying(stargrepNode());
    expect(await Effect.runPromise(read())).toBe(128);
    expect(fake.sent).toHaveLength(1);
    const [sent] = fake.sent;
    expect(sent?.url.pathname).toBe("/graphql");
    expect(sent?.headers.authorization).toContain(GitHubFake.token);
    expect(JSON.parse(sent?.body ?? "{}").variables).toEqual({ o0: "stefanofa", n0: "stargrep" });
  });

  it("answers null for a repo under the name that is not Stargrep's, or a name GitHub has no repo for", async () => {
    expect(await Effect.runPromise(replying(stargrepNode({ databaseId: 9 })).read())).toBeNull();
    expect(await Effect.runPromise(replying(null).read())).toBeNull();
  });

  it("answers null for a spent budget, a missing token and a GitHub failure, and never fails", async () => {
    const spent = Layer.succeed(
      TokenGate.TokenGate,
      TokenGate.TokenGate.of({
        execute: () => Effect.fail(new TokenBudgetExhausted({ resource: "graphql", resetAt: 0 })),
      }),
    );
    expect(await Effect.runPromise(overGate(spent)())).toBeNull();
    expect(await Effect.runPromise(overGate(TokenGate.layerMissing)())).toBeNull();
    const failing = replying(null, [{ type: "INTERNAL", message: "boom" }]);
    expect(await Effect.runPromise(failing.read())).toBeNull();
  });
});
