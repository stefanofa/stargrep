import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Fake from "./github.fixture.ts";
import { GitHub } from "./github.ts";

const viewer = {
  ...Fake.ownerBodies.user.data.repositoryOwner,
  login: "ada",
  databaseId: 7,
  starredRepositories: { totalCount: 1775 },
};

describe("GitHub.viewer", () => {
  it.effect("reads the signed-in account and its starred count through the client with the API headers", () => {
    const fake = Fake.layer(() => ({ body: { data: { viewer } } }));
    return Effect.gen(function* () {
      expect(yield* (yield* GitHub).viewer).toMatchObject({
        account: { id: 7, login: "ada", type: "user" },
        starredCount: 1775,
      });
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]?.url.pathname).toBe("/graphql");
      expect(fake.sent[0]?.headers).toMatchObject({ "x-github-api-version": "2022-11-28", "user-agent": "stargrep" });
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("rejects GraphQL errors even when the response contains viewer data", () => {
    const fake = Fake.layer(() => ({
      body: { data: { viewer }, errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] },
    }));
    return Effect.gen(function* () {
      expect(yield* Effect.flip((yield* GitHub).viewer)).toMatchObject({
        _tag: "GitHubRequestFailed",
        operation: "viewer",
        reason: "graphql-errors",
      });
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect("uses the shared unauthorized classification for a rejected user token", () => {
    const fake = Fake.layer(() => ({ status: 401 }));
    return Effect.gen(function* () {
      expect(yield* Effect.flip((yield* GitHub).viewer)).toMatchObject({ _tag: "Unauthorized", operation: "viewer" });
      expect(fake.sent).toHaveLength(1);
    }).pipe(Effect.provide(fake.layer));
  });
});
