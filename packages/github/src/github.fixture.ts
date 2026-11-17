import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as GitHub from "./github.ts";
import type { BudgetShare } from "./schemas.ts";
import * as TokenGate from "./token-gate.ts";

export interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly transportError?: string;
  readonly stream?: "broken" | "hang";
}

export interface Sent {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly startedAt: number;
}

export type Handler = (sent: Sent, index: number) => Reply;

export const token = "ghp_fake_token_never_logged";

export const rateLimitHeaders = (remaining: number, resetSeconds = 3600, resource = "core") => ({
  "x-ratelimit-resource": resource,
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(resetSeconds),
});

export interface FakeStar {
  readonly repo: number;
  readonly starredAt: string;
  readonly description?: string;
  readonly topics?: ReadonlyArray<string>;
}

export const starItem = (star: FakeStar) => ({
  starred_at: star.starredAt,
  repo: {
    id: star.repo,
    node_id: `R_${star.repo}`,
    name: `repo-${star.repo}`,
    owner: { login: "owner" },
    private: false,
    description: star.description ?? null,
    topics: star.topics ?? [],
    language: null,
  },
});

export const starPage = (stars: ReadonlyArray<FakeStar>, sent: Sent): Reply => {
  const page = Number(sent.url.searchParams.get("page"));
  return {
    body: stars.slice((page - 1) * 100, page * 100).map(starItem),
    headers: {
      ...rateLimitHeaders(4000),
      ...(page * 100 < stars.length
        ? { link: `<https://api.github.com/user/1/starred?per_page=100&page=${page + 1}>; rel="next"` }
        : {}),
    },
  };
};

export const ownerCountReply = (totalCount: number): Reply => ({
  body: {
    data: { repositoryOwner: { ...ownerBodies.user.data.repositoryOwner, starredRepositories: { totalCount } } },
  },
  headers: rateLimitHeaders(4000, 3600, "graphql"),
});

// Recorded from GitHub's GraphQL API on 2026-11-06 with the query in owner.ts.
export const ownerBodies = {
  user: {
    data: {
      repositoryOwner: {
        __typename: "User",
        databaseId: 583231,
        login: "octocat",
        name: "The Octocat",
        avatarUrl: "https://avatars.githubusercontent.com/u/583231?u=a59fef2a493e2b67dd13754231daf220c82ba84d&v=4",
        followers: { totalCount: 24947 },
        repositories: { totalCount: 8 },
        starredRepositories: { totalCount: 3 },
      },
    },
  },
  org: {
    data: {
      repositoryOwner: {
        __typename: "Organization",
        databaseId: 9919,
        login: "github",
        name: "GitHub",
        avatarUrl: "https://avatars.githubusercontent.com/u/9919?v=4",
        repositories: { totalCount: 572 },
      },
    },
  },
  missing: { data: { repositoryOwner: null } },
};

export const ownerReply = (body: unknown): Reply => ({ body, headers: rateLimitHeaders(4000, 3600, "graphql") });

const streamed = (kind: "broken" | "hang", onRead: () => void) =>
  new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        onRead();
        if (kind === "broken") controller.error(new Error("broken body"));
        else return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );

const toResponse = (request: HttpClientRequest.HttpClientRequest, reply: Reply, onRead: () => void) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(
      reply.stream !== undefined
        ? streamed(reply.stream, onRead)
        : reply.body === undefined
          ? null
          : typeof reply.body === "string"
            ? reply.body
            : JSON.stringify(reply.body),
      { status: reply.status ?? 200, headers: reply.headers ?? {} },
    ),
  );

export const make = (handler: Handler) => {
  const sent: Array<Sent> = [];
  const reads = { count: 0 };
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const entry: Sent = {
        url,
        headers: request.headers,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined,
        startedAt: yield* Clock.currentTimeMillis,
      };
      sent.push(entry);
      const reply = handler(entry, sent.length - 1);
      if (reply.transportError !== undefined) {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error(reply.transportError) }),
        });
      }
      return toResponse(request, reply, () => {
        reads.count++;
      });
    }),
  );
  return { sent, reads, client: Layer.succeed(HttpClient.HttpClient, client) };
};

export const layer = (handler: Handler, share = 1 as BudgetShare) => {
  const fake = make(handler);
  const layer = GitHub.layer.pipe(
    Layer.provideMerge(TokenGate.layerMemory({ token: Redacted.make(token), share })),
    Layer.provide(fake.client),
  );
  return { sent: fake.sent, reads: fake.reads, layer };
};
