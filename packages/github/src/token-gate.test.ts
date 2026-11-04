import { describe, expect } from "bun:test";
import { effect } from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { GitHubRequestFailed, TokenBudgetExhausted } from "./errors.ts";
import * as Fake from "./github.fixture.ts";
import * as GitHub from "./github.ts";
import type { BudgetShare, Login, RepoNodeId } from "./schemas.ts";
import * as TokenBudget from "./token-budget.ts";
import * as TokenGate from "./token-gate.ts";

describe("TokenGate.layerMemory", () => {
  effect("keeps one exchange per token in flight, from send until its body is read", () => {
    let sent = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        sent++;
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        const body = new ReadableStream<Uint8Array>(
          {
            pull: (controller) => {
              controller.enqueue(new TextEncoder().encode("ok"));
              controller.close();
              inFlight--;
            },
          },
          { highWaterMark: 0 },
        );
        return HttpClientResponse.fromWeb(request, new Response(body, { headers: Fake.rateLimitHeaders(4000) }));
      }),
    );
    const layer = TokenGate.layerMemory({ token: Redacted.make(Fake.token), share: 1 as BudgetShare }).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    );
    return Effect.gen(function* () {
      const gate = yield* TokenGate.TokenGate;
      const replies = yield* Effect.all(
        Array.from({ length: 20 }, () =>
          gate.execute("list-stars", HttpClientRequest.get("https://api.github.com/rate_limit")),
        ),
        { concurrency: "unbounded" },
      );
      expect(replies.map((reply) => reply.body)).toEqual(Array.from({ length: 20 }, () => Option.some("ok")));
      expect(sent).toBe(20);
      expect(maxInFlight).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});

const viaRemote = (handler: Fake.Handler, share = 1 as BudgetShare) => {
  const fake = Fake.make(handler);
  const remoteCalls: Array<string> = [];
  const structuredClone = <A>(value: A): unknown => JSON.parse(JSON.stringify(value));
  const remote = Layer.unwrap(
    Effect.map(TokenGate.TokenGate, (local) => {
      const serve = TokenGate.serve(local);
      return TokenGate.layerRemote({
        execute: (request) => {
          remoteCalls.push(JSON.stringify(request));
          return serve(structuredClone(request)).pipe(Effect.map(structuredClone));
        },
      });
    }),
  ).pipe(
    Layer.provide(TokenGate.layerMemory({ token: Redacted.make(Fake.token), share }).pipe(Layer.provide(fake.client))),
  );
  return { ...fake, remoteCalls, layer: GitHub.layer.pipe(Layer.provideMerge(remote)) };
};

const login = "octocat" as Login;

describe("TokenGate.layerRemote", () => {
  effect("lists stars and counts them through a remote gate, with query and body intact", () => {
    const stars = Array.from({ length: 150 }, (_, i) => ({ repo: i + 1, starredAt: "2026-01-01T00:00:00Z" }));
    const fake = viaRemote((sent) =>
      sent.url.pathname === "/graphql" ? Fake.starCountReply(150) : Fake.starPage(stars, sent),
    );
    return Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const listed = yield* Stream.runCollect(github.stars(login));
      expect(listed.map((star) => `${star.repo.id}`)).toEqual(stars.map((star) => `${star.repo}`));
      expect(yield* github.starCount(login)).toBe(150);
      expect(fake.sent.map((sent) => sent.url.searchParams.get("page"))).toEqual(["1", "2", null]);
      expect(JSON.parse(fake.sent[2]?.body ?? "null")).toMatchObject({ variables: { login } });
      expect(fake.sent.every((sent) => sent.headers.authorization === `Bearer ${Fake.token}`)).toBe(true);
      expect(fake.remoteCalls.join("\n")).not.toContain(Fake.token);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("fails with TokenBudgetExhausted once the budget share is spent", () => {
    const fake = viaRemote(() => ({ body: [], headers: Fake.rateLimitHeaders(99, 7200) }), 0.01 as BudgetShare);
    return Effect.gen(function* () {
      const gate = yield* TokenGate.TokenGate;
      const request = HttpClientRequest.get("https://api.github.com/users/octocat/starred");
      yield* gate.execute("list-stars", request);
      const error = yield* Effect.flip(gate.execute("list-stars", request));
      expect(error).toBeInstanceOf(TokenBudgetExhausted);
      expect(error).toMatchObject({ resource: "core", resetAt: 7_200_000 });
    }).pipe(Effect.provide(fake.layer));
  });

  effect("reports a transport failure as GitHubRequestFailed", () => {
    const fake = viaRemote(() => ({ transportError: "connection reset" }));
    return Effect.gen(function* () {
      const gate = yield* TokenGate.TokenGate;
      const error = yield* Effect.flip(
        gate.execute("account", HttpClientRequest.get("https://api.github.com/users/octocat")),
      );
      expect(error).toBeInstanceOf(GitHubRequestFailed);
      expect(error).toMatchObject({ reason: "transport", path: "/users/octocat", status: null });
    }).pipe(Effect.provide(fake.layer));
  });

  effect("reports a remote call that breaks as a transport failure", () =>
    Effect.gen(function* () {
      const gate = yield* TokenGate.TokenGate;
      const error = yield* Effect.flip(
        gate.execute("account", HttpClientRequest.get("https://api.github.com/users/octocat")),
      );
      expect(error).toMatchObject({ _tag: "GitHubRequestFailed", reason: "transport" });
    }).pipe(Effect.provide(TokenGate.layerRemote({ execute: () => Effect.die(new Error("RPC receiver went away")) }))),
  );
});

describe("TokenGate.makeMemory across a restart", () => {
  effect("keeps the stored windows and applies the share the new instance starts with", () => {
    const fake = Fake.make((_sent, index) => ({
      body: [],
      headers: Fake.rateLimitHeaders(index === 0 ? 1000 : 400, 3600),
    }));
    const request = HttpClientRequest.get("https://api.github.com/users/octocat/starred");
    return Effect.gen(function* () {
      const first = yield* TokenGate.makeMemory({ token: Redacted.make(Fake.token), share: 0.5 as BudgetShare });
      yield* first.execute("list-stars", request);
      yield* first.execute("list-stars", request);
      expect((yield* Effect.flip(first.execute("list-stars", request)))._tag).toBe("TokenBudgetExhausted");
      const stored: unknown = JSON.parse(JSON.stringify((yield* first.budget).windows));

      const windows = TokenBudget.decodeWindows(stored);
      expect(Option.isSome(windows)).toBe(true);
      const restarted = yield* TokenGate.makeMemory({
        token: Redacted.make(Fake.token),
        share: 0.7 as BudgetShare,
        windows: Option.getOrUndefined(windows),
      });
      expect((yield* restarted.budget).windows).toEqual((yield* first.budget).windows);
      expect((yield* restarted.budget).share).toBe(0.7 as BudgetShare);
      expect((yield* restarted.execute("list-stars", request)).status).toBe(200);
      expect(fake.sent).toHaveLength(3);
    }).pipe(Effect.provide(fake.client));
  });

  effect("starts with no windows when the stored value does not decode", () =>
    Effect.sync(() => {
      expect(TokenBudget.decodeWindows({ core: { remaining: "many" } })).toEqual(Option.none());
      expect(TokenBudget.decodeWindows(undefined)).toEqual(Option.none());
    }),
  );
});

describe("TokenGate.layerMissing", () => {
  effect("fails every GitHub call with GitHubTokenMissing and sends nothing", () =>
    Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const errors = yield* Effect.all([
        Effect.flip(github.account(login)),
        Effect.flip(Stream.runCollect(github.stars(login))),
        Effect.flip(github.starCount(login)),
        Effect.flip(github.repoFacts(["R_1" as RepoNodeId])),
      ]);
      expect(errors.map((error) => error._tag)).toEqual(Array.from({ length: 4 }, () => "GitHubTokenMissing"));
      expect(errors.map((error) => error._tag === "GitHubTokenMissing" && error.operation)).toEqual([
        "account",
        "list-stars",
        "star-count",
        "repo-facts",
      ]);
    }).pipe(Effect.provide(GitHub.layer.pipe(Layer.provide(TokenGate.layerMissing)))),
  );
});
