import { describe, expect } from "bun:test";
import { effect } from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { GitHubTokenMissing } from "./errors.ts";
import * as FallbackGate from "./fallback-gate.ts";
import * as Fake from "./github.fixture.ts";
import * as GitHub from "./github.ts";
import type { BudgetShare, Login } from "./schemas.ts";
import * as TokenGate from "./token-gate.ts";

const userToken = "gho_user_token_never_logged";
const serverToken = "ghs_server_token_never_logged";

const request = HttpClientRequest.get("https://api.github.com/users/octocat/starred");

const tokenOf = (sent: Fake.Sent) =>
  sent.headers.authorization === `Bearer ${userToken}`
    ? "user"
    : sent.headers.authorization === `Bearer ${serverToken}`
      ? "server"
      : "other";

// GitHub as both tokens see it: each request spends one from the window of the token that sent it.
const github = (userRemaining: number, reply: (token: "user" | "server", remaining: number) => Fake.Reply | null) => {
  const remaining = { user: userRemaining, server: 5000 };
  return Fake.make((sent) => {
    const token = tokenOf(sent);
    if (token === "other") return { status: 401 };
    remaining[token]--;
    return reply(token, remaining[token]) ?? { body: [], headers: Fake.rateLimitHeaders(remaining[token]) };
  });
};

const gates = (fake: ReturnType<typeof Fake.make>) =>
  Effect.gen(function* () {
    const user = yield* TokenGate.makeMemory({ share: FallbackGate.userShare });
    const server = yield* TokenGate.makeMemory({ share: 1 as BudgetShare });
    return {
      user: TokenGate.TokenGate.of({ execute: user.execute(Redacted.make(userToken)) }),
      server: TokenGate.TokenGate.of({ execute: server.execute(Redacted.make(serverToken)) }),
    };
  }).pipe(Effect.provide(fake.client));

const fallbacksFor = (reason: FallbackGate.FallbackReason) =>
  Effect.map(Metric.value(Metric.withAttributes(FallbackGate.fallbacks, { reason })), (state) => state.count);

const sendTimes = (gate: TokenGate.TokenGate["Service"], count: number) =>
  Effect.forEach(Array.from({ length: count }), () => gate.execute("list-stars", request), { discard: true });

describe("FallbackGate.prefer", () => {
  effect("sends a user's job on their token until a fifth of the window is spent, then on the server's", () => {
    const fake = github(50, () => null);
    return Effect.gen(function* () {
      const { user, server } = yield* gates(fake);
      const job = yield* FallbackGate.prefer(user, server);
      const before = yield* fallbacksFor("budget");
      yield* sendTimes(job, 14);
      expect(fake.sent.map(tokenOf)).toEqual([
        ...Array.from({ length: 10 }, () => "user" as const),
        ...Array.from({ length: 4 }, () => "server" as const),
      ]);
      expect((yield* fallbacksFor("budget")) - before).toBe(1);
    });
  });

  effect("sends a later job on the user's token again once their window resets", () => {
    const fake = Fake.make((sent, index) =>
      tokenOf(sent) === "server"
        ? { body: [], headers: Fake.rateLimitHeaders(4000) }
        : sent.startedAt < 3_600_000
          ? { body: [], headers: Fake.rateLimitHeaders(49 - index, 3600) }
          : { body: [], headers: Fake.rateLimitHeaders(4999, 7200) },
    );
    return Effect.gen(function* () {
      const { user, server } = yield* gates(fake);
      yield* sendTimes(yield* FallbackGate.prefer(user, server), 11);
      yield* sendTimes(yield* FallbackGate.prefer(user, server), 1);
      expect(fake.sent.map(tokenOf).slice(9)).toEqual(["user", "server", "server"]);

      yield* TestClock.adjust("1 hour");
      yield* sendTimes(yield* FallbackGate.prefer(user, server), 1);
      expect(fake.sent.map(tokenOf).at(-1)).toBe("user");
    });
  });

  effect("moves a job to the server's token after GitHub rejects the user's token, and logs it once", () => {
    const fake = github(4000, (token) =>
      token === "user" ? { status: 401, body: { message: "Bad credentials" } } : Fake.starCountReply(150),
    );
    const logs: Array<unknown> = [];
    return Effect.gen(function* () {
      const { user, server } = yield* gates(fake);
      const job = yield* FallbackGate.prefer(user, server);
      const before = yield* fallbacksFor("unauthorized");
      const client = yield* Effect.provide(
        GitHub.GitHub,
        GitHub.layer.pipe(Layer.provide(Layer.succeed(TokenGate.TokenGate, job))),
      );
      const counts = yield* Effect.all([client.starCount("octocat" as Login), client.starCount("hubot" as Login)]);
      expect(counts).toEqual([150, 150]);
      expect(fake.sent.map(tokenOf)).toEqual(["user", "server", "server"]);
      expect((yield* fallbacksFor("unauthorized")) - before).toBe(1);
      expect(logs).toEqual([
        ["A user's job moved to the server's GitHub token", { reason: "unauthorized", operation: "star-count" }],
      ]);
      expect(JSON.stringify(logs)).not.toContain(userToken);
    }).pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])));
  });

  effect("moves a job to the server's token when the user's token cannot be read", () => {
    const fake = github(4000, () => null);
    return Effect.gen(function* () {
      const { server } = yield* gates(fake);
      const unreadable = TokenGate.TokenGate.of({
        execute: (operation) => Effect.fail(new GitHubTokenMissing({ operation })),
      });
      const before = yield* fallbacksFor("token-unavailable");
      yield* sendTimes(yield* FallbackGate.prefer(unreadable, server), 2);
      expect(fake.sent.map(tokenOf)).toEqual(["server", "server"]);
      expect((yield* fallbacksFor("token-unavailable")) - before).toBe(1);
    });
  });

  effect("moves a job to the server's token when the user's own tools spent their window", () => {
    const fake = github(4000, (token) =>
      token === "user"
        ? { status: 403, body: { message: "API rate limit exceeded" }, headers: Fake.rateLimitHeaders(0) }
        : null,
    );
    return Effect.gen(function* () {
      const { user, server } = yield* gates(fake);
      const before = yield* fallbacksFor("rate-limited");
      const reply = yield* (yield* FallbackGate.prefer(user, server)).execute("list-stars", request);
      expect(reply.status).toBe(200);
      expect(fake.sent.map(tokenOf)).toEqual(["user", "server"]);
      expect((yield* fallbacksFor("rate-limited")) - before).toBe(1);
    });
  });

  effect("waits out a secondary rate limit on the user's token, which still has quota", () => {
    const fake = github(4000, (token, remaining) =>
      token === "user" && remaining === 3999
        ? {
            status: 403,
            body: { message: "You have exceeded a secondary rate limit" },
            headers: Fake.rateLimitHeaders(remaining),
          }
        : Fake.starCountReply(150),
    );
    return Effect.gen(function* () {
      const { user, server } = yield* gates(fake);
      const job = yield* FallbackGate.prefer(user, server);
      const client = yield* Effect.provide(
        GitHub.GitHub,
        GitHub.layer.pipe(Layer.provide(Layer.succeed(TokenGate.TokenGate, job))),
      );
      const fiber = yield* Effect.forkChild(client.starCount("octocat" as Login));
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(fiber)).toBe(150);
      expect(fake.sent.map(tokenOf)).toEqual(["user", "user"]);
    });
  });
});
