import { createExecutionContext, createMessageBatch, evictDurableObject, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { withClient } from "@stargrep/db/local-database";
import type { RemoteRequest } from "@stargrep/github/token-gate";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const replies: Array<{ path: string; login: string | undefined; token: string | undefined; response: () => Response }> =
  [];
const respond = (
  path: string,
  status: number,
  body: unknown,
  responseHeaders: Record<string, string> = {},
  login?: string,
  token?: string,
) => {
  replies.push({
    path,
    login,
    token,
    response: () =>
      typeof body === "string"
        ? new Response(body, { status, headers: responseHeaders })
        : Response.json(body, { status, headers: responseHeaders }),
  });
};
beforeEach(() => {
  replies.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = new Request(input, init);
    const url = new URL(sent.url);
    const body = await sent.text();
    const index = replies.findIndex(
      (reply) =>
        reply.path === url.pathname + url.search &&
        (reply.login === undefined || body.includes(`"login":"${reply.login}"`)),
    );
    if (url.origin !== "https://api.github.com" || index === -1)
      throw new Error(`Unexpected outbound request: ${url.pathname}${url.search}`);
    const [reply] = replies.splice(index, 1);
    if (reply === undefined) throw new Error("Missing intercepted response");
    if (reply.token !== undefined) expect(sent.headers.get("authorization")).toBe(`Bearer ${reply.token}`);
    return reply.response();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(replies).toEqual([]);
});

const headers = (remaining: number) => ({
  "content-type": "application/json",
  "x-ratelimit-resource": "core",
  "x-ratelimit-limit": "100",
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": "4102444800",
});
const request: RemoteRequest = {
  operation: "owner",
  method: "GET",
  url: "https://api.github.com/users/octocat",
  headers: {},
  body: null,
};

for (const [name, share] of [
  ["GitHubGate", 0.5],
  ["UserGitHubGate", 0.2],
] as const) {
  it(`${name} sends through its real namespace and keeps an exhausted budget after eviction`, async () => {
    const stub = env[name].getByName("evicted");
    const token = name === "GitHubGate" ? "fixture-server-token" : "fixture-user-token";
    for (const remaining of [100, 100 * (1 - share)]) {
      respond("/users/octocat", 200, { login: "octocat" }, headers(remaining), undefined, token);
      expect(await stub.execute(request, token)).toMatchObject({ _tag: "Replied", status: 200 });
    }
    expect(await stub.execute(request, token)).toMatchObject({ _tag: "TokenBudgetExhausted", resource: "core" });
    await evictDurableObject(stub);
    expect(await stub.execute(request, token)).toMatchObject({ _tag: "TokenBudgetExhausted", resource: "core" });
  });
}

it("delivers one batch through the generated queue handler with one acknowledgement or retry per message", async () => {
  respond(
    "/graphql",
    200,
    {
      data: {
        repositoryOwner: {
          __typename: "Organization",
          databaseId: 900001,
          login: "good-org",
          name: null,
          avatarUrl: null,
          repositories: { totalCount: 0 },
        },
      },
    },
    {},
    "good-org",
  );
  respond("/users/good-org/starred?sort=created&direction=desc&per_page=100&page=1", 200, []);
  respond("/graphql", 403, { message: "Resource not accessible by integration" }, {}, "retry-user");
  const batch = createMessageBatch(
    "sync-stars",
    ["good-org", "retry-user"].map((login, index) => ({
      id: `message-${index}`,
      timestamp: 0,
      attempts: 1,
      body: { login, mode: "full" },
    })),
  );
  const calls: Array<string> = [];
  for (const message of batch.messages) {
    const ack = message.ack.bind(message);
    const retry = message.retry.bind(message);
    message.ack = () => {
      calls.push(`ack ${message.id}`);
      ack();
    };
    message.retry = (options) => {
      calls.push(`retry ${message.id}`);
      retry(options);
    };
  }
  const context = createExecutionContext();
  const { default: Worker } = await import(env.RUNTIME_ENTRY);
  await new Worker(context, env).queue(batch);
  const result = await getQueueResult(batch, context);
  expect(result.explicitAcks).toEqual(["message-0"]);
  expect(result.retryMessages).toEqual([{ msgId: "message-1" }]);
  expect(calls).toEqual(["ack message-0", "retry message-1"]);
  const rows = await Effect.runPromise(
    withClient(
      env.Database.connectionString,
      async (client) =>
        (
          await client.query(
            "select login, stars_synced_at is not null as synced from github_accounts where id = 900001",
          )
        ).rows,
    ),
  );
  expect(rows).toEqual([{ login: "good-org", synced: true }]);
});

it("caches a README read in a GraphQL batch in the real R2 binding through the enrichment queue entry", async () => {
  await Effect.runPromise(
    withClient(env.Database.connectionString, (client) =>
      client.query("insert into repos (id, node_id, owner, name) values (900002, 'R_900002', 'owner', 'kit')"),
    ),
  );
  const readme = "# Kit\n\nA cached README";
  // git hash-object of the README, which the batch must match before it trusts the text.
  const oid = "9821655e8d7647bcd72fadf124c64da876b51960";
  respond("/graphql", 200, {
    data: {
      nodes: [
        {
          databaseId: 900002,
          id: "R_900002",
          name: "kit",
          owner: { __typename: "Organization", login: "owner", avatarUrl: "https://avatars.githubusercontent.com/u/7" },
          description: "a kit",
          homepageUrl: null,
          primaryLanguage: null,
          licenseInfo: null,
          repositoryTopics: { nodes: [] },
          createdAt: "2020-01-01T00:00:00Z",
          pushedAt: null,
          isArchived: false,
          isFork: false,
          isPrivate: false,
          // Enough stars for the summary policy to read the README.
          stargazerCount: 500,
          forkCount: 0,
          root: { entries: [{ name: "README.md", type: "blob", oid }] },
        },
      ],
    },
  });
  respond("/graphql", 200, { data: { b0: { object: { text: readme } } } });
  const batch = createMessageBatch("enrich-repo", [
    { id: "enrich", timestamp: 0, attempts: 1, body: { repoId: 900002 } },
  ]);
  const context = createExecutionContext();
  const { default: Worker } = await import(env.RUNTIME_ENTRY);
  await new Worker(context, env).queue(batch);
  expect((await getQueueResult(batch, context)).explicitAcks).toEqual(["enrich"]);
  expect(await (await env.Readmes.get(`readmes/${oid}`))?.text()).toBe(readme);
});
