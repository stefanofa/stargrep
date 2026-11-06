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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
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

describe("GitHubTokens.read", () => {
  it.live("reads a token that has not expired without asking GitHub", () =>
    Effect.gen(function* () {
      const { refreshes } = yield* stubTokenEndpoint({});
      const userId = yield* seedUser({
        accessToken: "ghu_current",
        expiresAt: (yield* Clock.currentTimeMillis) + hour,
      });
      const token = yield* (yield* reader).read(userId);
      expect(Redacted.value(token)).toBe("ghu_current");
      expect(refreshes).toEqual([]);
    }).pipe(Effect.provide(database)),
  );

  it.live("refreshes an expired token through GitHub and stores the new one encrypted", () =>
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
        expiresAt: (yield* Clock.currentTimeMillis) - hour,
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
    }).pipe(Effect.provide(database)),
  );

  it.live("fails when GitHub refuses the refresh token, instead of answering with the expired token", () =>
    Effect.gen(function* () {
      yield* stubTokenEndpoint({
        error: "bad_refresh_token",
        error_description: "The refresh token passed is incorrect or expired.",
      });
      const userId = yield* seedUser({
        accessToken: "ghu_expired",
        expiresAt: (yield* Clock.currentTimeMillis) - hour,
      });
      const error = yield* Effect.flip((yield* reader).read(userId));
      expect(error).toMatchObject({ _tag: "AuthFailed", operation: "token" });
      expect(JSON.stringify(error)).not.toContain("ghu_expired");
    }).pipe(Effect.provide(database)),
  );

  it.live("fails for a user with no GitHub account", () =>
    Effect.gen(function* () {
      yield* stubTokenEndpoint({});
      const error = yield* Effect.flip((yield* reader).read(UserId.make("nobody")));
      expect(error).toMatchObject({ _tag: "AuthFailed", operation: "token" });
    }).pipe(Effect.provide(database)),
  );
});
