import { describe, expect } from "bun:test";
import * as AuthSchema from "@stargrep/db/auth-schema";
import { UserId } from "@stargrep/db/auth-schema";
import * as Memory from "@stargrep/db/memory";
import * as it from "@stargrep/testing";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import type { TokenConfig } from "./config.ts";
import * as Tokens from "./tokens.ts";

const config: TokenConfig = {
  secret: Redacted.make("better-auth-secret-for-tests-only-0123456789"),
  clientId: "Iv23test",
  clientSecret: Option.some(Redacted.make("client-secret-canary")),
};

const hour = 60 * 60 * 1000;

class Database extends Context.Service<Database, ReturnType<typeof drizzle>>()("@stargrep/auth/tokens.test/Database") {}

const database = Layer.effect(
  Database,
  Effect.map(Memory.open, ({ client }) => drizzle({ client })),
);

// A GitHub token endpoint that answers refreshes as GitHub does, recording each one.
const stubTokenEndpoint = (answer: Record<string, unknown>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const original = globalThis.fetch;
      const refreshes: Array<URLSearchParams> = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== "https://github.com/login/oauth/access_token") throw new Error(`Unexpected fetch of ${url}`);
        refreshes.push(new URLSearchParams(String(init?.body)));
        return Response.json(answer);
      }) as typeof fetch;
      return { original, refreshes };
    }),
    ({ original }) =>
      Effect.sync(() => {
        globalThis.fetch = original;
      }),
  );

let seeded = 0;

const seedUser = (account: { readonly accessToken: string; readonly expiresAt: number | null }) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const id = `user-${++seeded}`;
    yield* Effect.promise(() =>
      db.insert(AuthSchema.user).values({ id, name: "Octo", email: `${id}@example.com`, emailVerified: true }),
    );
    yield* Effect.promise(() =>
      db.insert(AuthSchema.account).values({
        id: `account-${id}`,
        accountId: String(1000 + seeded),
        providerId: "github",
        userId: id,
        accessToken: account.accessToken,
        refreshToken: "ghr_refresh_token",
        accessTokenExpiresAt:
          account.expiresAt === null ? null : DateTime.toDateUtc(DateTime.makeUnsafe(account.expiresAt)),
      }),
    );
    return UserId.make(id);
  });

const reader = Effect.map(Database, (db) =>
  Tokens.make(drizzleAdapter(db, { provider: "pg", schema: AuthSchema }), config),
);

const storedToken = (userId: UserId) =>
  Effect.flatMap(Database, (db) =>
    Effect.promise(() =>
      db
        .select({ accessToken: AuthSchema.account.accessToken })
        .from(AuthSchema.account)
        .where(eq(AuthSchema.account.userId, userId)),
    ),
  ).pipe(Effect.map((rows) => rows[0]?.accessToken ?? null));

it.layer(database, { timeout: 30_000 })("GitHubTokens.read", (test) => {
  test.effect("reads a token that has not expired without asking GitHub", () =>
    Effect.gen(function* () {
      const { refreshes } = yield* stubTokenEndpoint({});
      const userId = yield* seedUser({
        accessToken: "ghu_current",
        expiresAt: (yield* TestClock.withLive(Clock.currentTimeMillis)) + hour,
      });
      const token = yield* (yield* reader).read(userId);
      expect(Redacted.value(token)).toBe("ghu_current");
      expect(refreshes).toEqual([]);
    }),
  );

  test.effect("refreshes an expired token through GitHub and stores the new one encrypted", () =>
    Effect.gen(function* () {
      const { refreshes } = yield* stubTokenEndpoint({
        access_token: "ghu_refreshed",
        refresh_token: "ghr_next",
        expires_in: 28_800,
        refresh_token_expires_in: 15_897_600,
        token_type: "bearer",
      });
      const userId = yield* seedUser({
        accessToken: "ghu_expired",
        expiresAt: (yield* TestClock.withLive(Clock.currentTimeMillis)) - hour,
      });
      const tokens = yield* reader;
      expect(Redacted.value(yield* tokens.read(userId))).toBe("ghu_refreshed");
      expect(refreshes.map((body) => [body.get("grant_type"), body.get("refresh_token")])).toEqual([
        ["refresh_token", "ghr_refresh_token"],
      ]);
      const stored = yield* storedToken(userId);
      expect(stored).not.toBeNull();
      expect(stored).not.toContain("ghu_refreshed");
      expect(Redacted.value(yield* tokens.read(userId))).toBe("ghu_refreshed");
      expect(refreshes).toHaveLength(1);
    }),
  );

  test.effect("fails when GitHub refuses the refresh token, instead of answering with the expired token", () =>
    Effect.gen(function* () {
      yield* stubTokenEndpoint({
        error: "bad_refresh_token",
        error_description: "The refresh token passed is incorrect or expired.",
      });
      const userId = yield* seedUser({
        accessToken: "ghu_expired",
        expiresAt: (yield* TestClock.withLive(Clock.currentTimeMillis)) - hour,
      });
      const error = yield* Effect.flip((yield* reader).read(userId));
      expect(error).toMatchObject({ _tag: "AuthFailed", operation: "token" });
      expect(JSON.stringify(error)).not.toContain("ghu_expired");
    }),
  );

  test.effect("fails for a user with no GitHub account", () =>
    Effect.gen(function* () {
      yield* stubTokenEndpoint({});
      const error = yield* Effect.flip((yield* reader).read(UserId.make("nobody")));
      expect(error).toMatchObject({ _tag: "AuthFailed", operation: "token" });
    }),
  );

  test.effect("keeps the newest refresh token when two jobs refresh the same expired token at once", () =>
    Effect.gen(function* () {
      const sent: Array<string | null> = [];
      const both = Promise.withResolvers<void>();
      const firstStored = Promise.withResolvers<void>();
      // GitHub accepts the first refresh and refuses the second, which reuses the same refresh token. The second
      // answers only once the first one's tokens are stored.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const original = globalThis.fetch;
          globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            const refresh = new URLSearchParams(String(init?.body)).get("refresh_token");
            const count = sent.push(refresh);
            if (count === 2) both.resolve();
            if (count <= 2) await both.promise;
            if (count === 2) {
              await firstStored.promise;
              return Response.json({ error: "bad_refresh_token", error_description: "The refresh token was used" });
            }
            return Response.json({
              access_token: `ghu_fresh_${count}`,
              refresh_token: `ghr_next_${count}`,
              expires_in: 28_800,
              refresh_token_expires_in: 15_897_600,
              token_type: "bearer",
            });
          }) as typeof fetch;
          return original;
        }),
        (original) =>
          Effect.sync(() => {
            globalThis.fetch = original;
          }),
      );
      const userId = yield* seedUser({
        accessToken: "ghu_expired",
        expiresAt: (yield* TestClock.withLive(Clock.currentTimeMillis)) - hour,
      });
      const tokens = yield* reader;
      const first = tokens.read(userId).pipe(Effect.ensuring(Effect.sync(() => firstStored.resolve())));
      const reads = yield* Effect.all([Effect.result(first), Effect.result(tokens.read(userId))], {
        concurrency: 2,
      });
      expect(reads.map((read) => read._tag)).toEqual(["Success", "Failure"]);

      const db = yield* Database;
      const expired = DateTime.toDateUtc(
        DateTime.makeUnsafe((yield* TestClock.withLive(Clock.currentTimeMillis)) - hour),
      );
      yield* Effect.promise(() =>
        db
          .update(AuthSchema.account)
          .set({ accessTokenExpiresAt: expired })
          .where(eq(AuthSchema.account.userId, userId)),
      );
      expect(Redacted.value(yield* tokens.read(userId))).toBe("ghu_fresh_3");
      expect(sent).toEqual(["ghr_refresh_token", "ghr_refresh_token", "ghr_next_1"]);
    }).pipe(Effect.scoped),
  );
});

describe("GitHubTokens.bounded", () => {
  it.effect("returns a timed-out read at once, while the connection it held still waits to close", () =>
    Effect.gen(function* () {
      const closed = { done: false };
      const stalled = Effect.acquireRelease(Effect.void, () =>
        Effect.andThen(
          Effect.never,
          Effect.sync(() => {
            closed.done = true;
          }),
        ),
      ).pipe(Effect.andThen(Effect.never), Effect.scoped);
      const fiber = yield* Effect.forkChild(Effect.flip(Tokens.bounded(stalled)));
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "AuthFailed", operation: "token" });
      expect(closed.done).toBe(false);
    }),
  );
});
