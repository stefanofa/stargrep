import { TokenBudgetExhausted } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import * as GitHubFake from "@stargrep/github/github.fixture";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { lookupOwner } from "../src/owner-lookup.ts";

const reply = (body: unknown) => {
  const fake = GitHubFake.layer(() => GitHubFake.ownerReply(body));
  return { fake, lookup: lookupOwner(fake.layer) };
};

const overGate = (gate: Layer.Layer<TokenGate.TokenGate>) => lookupOwner(GitHub.layer.pipe(Layer.provide(gate)));

describe("lookupOwner", () => {
  it("finds a user with its facts and starred total, as plain data", async () => {
    const { fake, lookup } = reply(GitHubFake.ownerBodies.user);
    expect(await Effect.runPromise(lookup("octocat"))).toEqual({
      _tag: "Found",
      owner: {
        account: {
          id: 583231,
          login: "octocat",
          type: "user",
          name: "The Octocat",
          avatarUrl: GitHubFake.ownerBodies.user.data.repositoryOwner.avatarUrl,
          followers: 24947,
          publicRepos: 8,
        },
        starredTotal: 3,
      },
    });
    expect(fake.sent.map((sent) => sent.url.pathname)).toEqual(["/graphql"]);
  });

  it("finds an org with no followers and a starred total of 0", async () => {
    const { lookup } = reply(GitHubFake.ownerBodies.org);
    expect(await Effect.runPromise(lookup("github"))).toMatchObject({
      _tag: "Found",
      owner: { account: { type: "org", followers: null }, starredTotal: 0 },
    });
  });

  it("answers missing for a login GitHub does not have, and for a value that is no login, without asking", async () => {
    const { fake, lookup } = reply(GitHubFake.ownerBodies.missing);
    expect(await Effect.runPromise(lookup("no-such-login"))).toEqual({ _tag: "Missing" });
    expect(await Effect.runPromise(lookup(""))).toEqual({ _tag: "Missing" });
    expect(fake.sent).toHaveLength(1);
  });

  it("answers unavailable for a spent budget, a missing token and a GitHub failure", async () => {
    const spent = Layer.succeed(
      TokenGate.TokenGate,
      TokenGate.TokenGate.of({
        execute: () => Effect.fail(new TokenBudgetExhausted({ resource: "graphql", resetAt: 0 })),
      }),
    );
    expect(await Effect.runPromise(overGate(spent)("octocat"))).toEqual({ _tag: "Unavailable", reason: "budget" });
    expect(await Effect.runPromise(overGate(TokenGate.layerMissing)("octocat"))).toEqual({
      _tag: "Unavailable",
      reason: "github",
    });
    const { lookup } = reply({ data: null, errors: [{ type: "INTERNAL", message: "boom" }] });
    expect(await Effect.runPromise(lookup("octocat"))).toEqual({ _tag: "Unavailable", reason: "github" });
  });
});
