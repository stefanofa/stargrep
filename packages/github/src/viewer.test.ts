import { describe, expect, test } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import { GitHubAccountId, Login } from "./schemas.ts";
import * as Viewer from "./viewer.ts";

describe("viewer", () => {
  it.effect("reads the signed-in account and its starred count from one query", () =>
    Effect.gen(function* () {
      const decoded = yield* Viewer.decodeResponse(
        JSON.stringify({
          data: {
            viewer: {
              databaseId: 7,
              login: "ada",
              name: null,
              avatarUrl: "https://avatars.githubusercontent.com/u/7",
              followers: { totalCount: 10 },
              repositories: { totalCount: 3 },
              starredRepositories: { totalCount: 1775 },
            },
          },
        }),
      );
      expect(decoded.data && Viewer.toViewer(decoded.data.viewer)).toEqual({
        account: {
          id: GitHubAccountId.make(7),
          login: Login.make("ada"),
          type: "user",
          name: null,
          avatarUrl: "https://avatars.githubusercontent.com/u/7",
          followers: 10,
          publicRepos: 3,
        },
        starredCount: 1775,
      });
    }),
  );

  it.effect("keeps GraphQL errors instead of inventing a viewer", () =>
    Effect.gen(function* () {
      const decoded = yield* Viewer.decodeResponse(
        JSON.stringify({ data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] }),
      );
      expect(decoded.data).toBeNull();
    }),
  );

  test("sends the API headers", () => {
    expect(Viewer.request.headers).toMatchObject({ "x-github-api-version": "2022-11-28", "user-agent": "stargrep" });
  });
});
