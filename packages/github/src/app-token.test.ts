import { describe, expect, test } from "bun:test";
import { effect } from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scheduler from "effect/Scheduler";
import * as TestClock from "effect/testing/TestClock";
import { AppKeyInvalid } from "./app-jwt.ts";
import * as AppToken from "./app-token.ts";
import * as Fake from "./github.fixture.ts";
import type { BudgetShare } from "./schemas.ts";
import * as TokenGate from "./token-gate.ts";

const now = Date.parse("2026-11-06T12:00:00Z");
const minute = 60_000;
const hour = 60 * minute;
const jwt = "jwt-for-tests";

const credentials = { clientId: "Iv23liTestClient", privateKey: Redacted.make("unused by the fake signer") };
const signer = Effect.succeed(Redacted.make(jwt));

// GitHub's App endpoints for an App owned by stefanofa and installed there as 42. Each mint answers a new token that
// expires an hour after it was asked.
const github = (handler?: (sent: Fake.Sent) => Fake.Reply | undefined) => {
  const minted = { count: 0 };
  return Fake.make((sent) => {
    const custom = handler?.(sent);
    if (custom !== undefined) return custom;
    if (sent.url.pathname === "/app") return { body: { owner: { login: "stefanofa", type: "User" } } };
    if (sent.url.pathname === "/users/stefanofa/installation") return { body: { id: 42 } };
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(sent.url.pathname)) {
      minted.count++;
      return {
        status: 201,
        body: {
          token: `ghs_minted_${minted.count}`,
          expires_at: DateTime.formatIso(DateTime.makeUnsafe(sent.startedAt + hour)),
        },
      };
    }
    return { body: { login: "octocat" }, headers: Fake.rateLimitHeaders(4999) };
  });
};

const discovery = ["/app", "/users/stefanofa/installation"];

const mintsOf = (fake: ReturnType<typeof Fake.make>) =>
  fake.sent.filter((sent) => sent.url.pathname.endsWith("/access_tokens")).length;

const tokensOver = (fake: ReturnType<typeof Fake.make>, sign: AppToken.Options["signer"] = signer) =>
  AppToken.makeInstallationTokens({ credentials, signer: sign }).pipe(Effect.provide(fake.client));

const read = HttpClientRequest.get("https://api.github.com/users/octocat");

describe("AppToken.plan", () => {
  const held = (expiresIn: number) => Option.some({ token: Redacted.make("ghs_held"), expiresAt: now + expiresIn });
  const state = (overrides: Partial<AppToken.State>): AppToken.State => ({
    held: Option.none(),
    installation: Option.none(),
    mintAfter: 0,
    ...overrides,
  });

  test("uses a held token, refreshes it in its last five minutes, and mints only without a usable one", () => {
    const cases: Array<[string, AppToken.State, string]> = [
      ["no token", state({}), "Mint"],
      ["a fresh token", state({ held: held(30 * minute) }), "Use"],
      ["a token in its last five minutes", state({ held: held(4 * minute) }), "UseAndRefresh"],
      ["the same while GitHub says to wait", state({ held: held(4 * minute), mintAfter: now + minute }), "Use"],
      ["a token about to expire", state({ held: held(30_000) }), "Mint"],
      ["no usable token while GitHub says to wait", state({ mintAfter: now + minute }), "Wait"],
    ];
    expect(cases.map(([name, given]) => [name, AppToken.plan(given, now)._tag])).toEqual(
      cases.map(([name, , expected]) => [name, expected]),
    );
  });
});

describe("AppToken.makeInstallationTokens", () => {
  effect("mints for the owner's installation, and refreshes in the background in the token's last five minutes", () => {
    const fake = github();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const tokens = yield* tokensOver(fake);
      expect(Redacted.value(yield* tokens.current("owner"))).toBe("ghs_minted_1");
      yield* TestClock.adjust("54 minutes");
      expect(Redacted.value(yield* tokens.current("owner"))).toBe("ghs_minted_1");
      yield* TestClock.adjust("2 minutes");
      expect(Redacted.value(yield* tokens.current("owner"))).toBe("ghs_minted_1");
      yield* tokens.refreshed;
      expect(Redacted.value(yield* tokens.current("owner"))).toBe("ghs_minted_2");
      expect(fake.sent.map((sent) => sent.url.pathname)).toEqual([
        ...discovery,
        "/app/installations/42/access_tokens",
        "/app/installations/42/access_tokens",
      ]);
      expect(fake.sent.every((sent) => sent.headers.authorization === `Bearer ${jwt}`)).toBe(true);
    });
  });

  effect("ignores installations on other accounts, which never reach the owner's token", () => {
    const fake = github((sent) =>
      sent.url.pathname === "/app/installations" ? { body: [{ id: 7 }, { id: 42 }, { id: 99 }] } : undefined,
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      yield* (yield* tokensOver(fake)).current("owner");
      expect(fake.sent.map((sent) => sent.url.pathname)).toEqual([...discovery, "/app/installations/42/access_tokens"]);
    });
  });

  effect("looks the installation up again after the App was installed again under a new ID", () => {
    const state = { reinstalled: false };
    const fake = github((sent) => {
      if (!state.reinstalled) return undefined;
      if (sent.url.pathname === "/users/stefanofa/installation") return { body: { id: 43 } };
      return sent.url.pathname === "/app/installations/42/access_tokens" ? { status: 404 } : undefined;
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const tokens = yield* tokensOver(fake);
      yield* tokens.current("owner");
      state.reinstalled = true;
      yield* TestClock.adjust("56 minutes");
      yield* tokens.current("owner");
      yield* tokens.refreshed;
      expect(Redacted.value(yield* tokens.current("owner"))).toBe("ghs_minted_2");
      expect(fake.sent.map((sent) => sent.url.pathname).slice(3)).toEqual([
        "/app/installations/42/access_tokens",
        ...discovery,
        "/app/installations/43/access_tokens",
      ]);
    });
  });

  effect("serves requests from the held token while a refresh hangs, with one refresh in flight", () => {
    const state = { hang: false };
    const fake = github((sent) =>
      state.hang && sent.url.pathname.endsWith("/access_tokens") ? { status: 201, stream: "hang" } : undefined,
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const tokens = yield* tokensOver(fake);
      yield* tokens.current("owner");
      state.hang = true;
      yield* TestClock.adjust("56 minutes");
      const served = yield* Effect.all(Array.from({ length: 4 }, () => tokens.current("owner")));
      expect(served.map(Redacted.value)).toEqual(Array.from({ length: 4 }, () => "ghs_minted_1"));
      yield* TestClock.adjust("30 seconds");
      yield* tokens.refreshed;
      expect(mintsOf(fake)).toBe(2);
      expect(Redacted.value(yield* tokens.current("owner"))).toBe("ghs_minted_1");
    });
  });

  effect("frees the mint permit when a request is interrupted at any step while it starts a refresh", () => {
    const signed = { count: 0 };
    // Every refresh after the first mint fails at its signature, so it ends at once and the held token stays in its last
    // five minutes, and each request starts a refresh.
    const sign = Effect.suspend(() => (signed.count++ === 0 ? signer : Effect.fail(new AppKeyInvalid())));
    const fake = github();
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const tokens = yield* tokensOver(fake, sign);
      yield* tokens.current("owner");
      yield* TestClock.adjust("56 minutes");
      // The request yields once it has run `steps` operations, and the interrupt lands there, so the sweep covers every
      // step until a request finishes first. A budget of one yields before any operation, so the sweep starts at two. A
      // permit nobody holds frees the waiter within a few turns.
      const sweep = { steps: 1, stuck: false, finished: false };
      while (!sweep.stuck && !sweep.finished) {
        sweep.steps++;
        const request = yield* Effect.forkChild(
          tokens.current("owner").pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, sweep.steps)),
          { startImmediately: true },
        );
        sweep.finished = request.pollUnsafe() !== undefined;
        yield* Fiber.interrupt(request);
        const free = yield* Effect.forkChild(tokens.refreshed, { startImmediately: true });
        for (let turn = 0; turn < 100 && free.pollUnsafe() === undefined; turn++) yield* Effect.yieldNow;
        sweep.stuck = free.pollUnsafe() === undefined;
        yield* Fiber.interrupt(free);
      }
      expect(sweep).toMatchObject({ stuck: false, finished: true });
      expect(sweep.steps).toBeGreaterThan(10);
    }).pipe(Effect.provide(Logger.layer([])));
  });

  effect("sends no refresh while GitHub's retry-after runs, and keeps serving the held token", () => {
    const state = { limited: false };
    const fake = github((sent) =>
      state.limited && sent.url.pathname.endsWith("/access_tokens")
        ? { status: 429, headers: { "retry-after": "60" } }
        : undefined,
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const tokens = yield* tokensOver(fake);
      yield* tokens.current("owner");
      state.limited = true;
      yield* TestClock.adjust("56 minutes");
      for (let second = 0; second < 20; second++) {
        expect(Redacted.value(yield* tokens.current("owner"))).toBe("ghs_minted_1");
        yield* tokens.refreshed;
        yield* TestClock.adjust("1 second");
      }
      expect(mintsOf(fake)).toBe(2);
      yield* TestClock.adjust("41 seconds");
      yield* tokens.current("owner");
      yield* tokens.refreshed;
      expect(mintsOf(fake)).toBe(3);
    });
  });

  effect("sends one mint for requests a gate queues while GitHub rate limits the App, and defers them all", () => {
    const fake = github((sent) =>
      sent.url.pathname.endsWith("/access_tokens") ? { status: 429, headers: { "retry-after": "60" } } : undefined,
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const tokens = yield* tokensOver(fake);
      const gate = yield* TokenGate.makeMemory({ share: 1 as BudgetShare }).pipe(Effect.provide(fake.client));
      const errors = yield* Effect.all(
        Array.from({ length: 4 }, () => Effect.flip(gate.execute(tokens)("owner", read))),
        { concurrency: "unbounded" },
      );
      expect(errors).toMatchObject(
        Array.from({ length: 4 }, () => ({ _tag: "TokenBudgetExhausted", resetAt: now + minute })),
      );
      expect(mintsOf(fake)).toBe(1);
    });
  });

  effect("waits a minute on a secondary rate limit that leaves quota, and until the reset when nothing remains", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const replies: Array<Fake.Reply> = [
        {
          status: 403,
          body: { message: "You have exceeded a secondary rate limit" },
          headers: Fake.rateLimitHeaders(4990, now / 1000 + 3540),
        },
        {
          status: 403,
          body: { message: "API rate limit exceeded" },
          headers: Fake.rateLimitHeaders(0, now / 1000 + 600),
        },
        { status: 429, headers: { "retry-after": "120" }, stream: "hang" },
      ];
      const waits: Array<unknown> = [];
      for (const reply of replies) {
        const fake = github((sent) => (sent.url.pathname.endsWith("/access_tokens") ? reply : undefined));
        waits.push(yield* Effect.flip((yield* tokensOver(fake)).current("owner")));
      }
      expect(waits).toMatchObject([
        { _tag: "TokenBudgetExhausted", resetAt: now + minute },
        { _tag: "TokenBudgetExhausted", resetAt: now + 600_000 },
        { _tag: "TokenBudgetExhausted", resetAt: now + 120_000 },
      ]);
    }),
  );

  effect("mints a new token and sends the read again when GitHub rejects the held one after a reinstall", () => {
    const fake = github((sent) =>
      sent.url.pathname === "/users/octocat" && sent.headers.authorization === "Bearer ghs_minted_1"
        ? { status: 401, body: { message: "Bad credentials" } }
        : undefined,
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const tokens = yield* tokensOver(fake);
      const gate = yield* TokenGate.makeMemory({ share: 1 as BudgetShare }).pipe(Effect.provide(fake.client));
      expect((yield* gate.execute(tokens)("owner", read)).status).toBe(200);
      expect(fake.sent.map((sent) => sent.url.pathname)).toEqual([
        ...discovery,
        "/app/installations/42/access_tokens",
        "/users/octocat",
        "/app/installations/42/access_tokens",
        "/users/octocat",
      ]);
    });
  });

  effect("reports the token as missing when GitHub refuses the JWT or the App, or the key is wrong", () => {
    const logs: Array<unknown> = [];
    const cases: Array<[AppToken.Options["signer"], (sent: Fake.Sent) => Fake.Reply | undefined]> = [
      [signer, (sent) => (sent.url.pathname === "/app" ? { status: 401 } : undefined)],
      [signer, (sent) => (sent.url.pathname === "/users/stefanofa/installation" ? { status: 404 } : undefined)],
      [
        signer,
        (sent) =>
          sent.url.pathname.endsWith("/access_tokens")
            ? { status: 403, body: { message: "This installation has been suspended" } }
            : undefined,
      ],
      [Effect.fail(new AppKeyInvalid()), () => undefined],
    ];
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      for (const [sign, reply] of cases) {
        const error = yield* Effect.flip((yield* tokensOver(github(reply), sign)).current("owner"));
        expect(error).toMatchObject({ _tag: "GitHubTokenMissing", operation: "owner" });
      }
      expect(logs.map((message) => (message as Array<{ reason?: string }>)[1]?.reason)).toEqual([
        "jwt-rejected",
        "installation",
        "forbidden",
        "key",
      ]);
      expect(JSON.stringify(logs)).not.toContain(jwt);
    }).pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])));
  });

  effect("fails a mint GitHub could not answer, or answered with a body it cannot read, so the queue retries it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const failures: Array<unknown> = [];
      for (const reply of [{ status: 503 }, { status: 201, body: "not json" }]) {
        const fake = github((sent) => (sent.url.pathname.endsWith("/access_tokens") ? reply : undefined));
        failures.push(yield* Effect.flip((yield* tokensOver(fake)).current("repo-facts")));
      }
      expect(failures).toMatchObject([
        { _tag: "GitHubRequestFailed", operation: "app-token", status: 503, reason: "status" },
        { _tag: "GitHubRequestFailed", operation: "app-token", status: 201, reason: "malformed" },
      ]);
    }),
  );
});
