import { AuthFailed } from "@stargrep/auth/auth";
import { GitHubTokens } from "@stargrep/auth/tokens";
import { EnrichRepo } from "@stargrep/core/repos";
import { StarSync } from "@stargrep/core/stars";
import { UserId } from "@stargrep/db/auth-schema";
import { TokenBudgetExhausted } from "@stargrep/github/errors";
import type { RepoId } from "@stargrep/github/schemas";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import * as EnrichRepoConsumer from "../src/consumers/enrich-repo.ts";
import * as Settle from "../src/consumers/settle.ts";
import type { UserGitHubGate } from "../src/github-gate.ts";
import * as UserGate from "../src/user-gate.ts";
import {
  answering,
  batchOf,
  inMillis,
  recordingLine,
  recordingQueues,
  reply,
  report,
  run,
  runtimeContext,
  sending,
  syncing,
} from "./consumers.fixture.ts";

// A signed-in user's gate that answers their first `own` requests itself and sends the rest to the server's gate.
const userGates = (own: number) => {
  const asked: Array<UserId> = [];
  const layer = Layer.succeed(
    UserGate.UserGates,
    UserGate.UserGates.of({
      forJob: Effect.fn("UserGates.forJob")(function* ({ paidBy, sent }) {
        const source = yield* TokenGate.TokenGate;
        const server = sent === undefined ? source : TokenGate.counting(source, sent);
        if (paidBy !== undefined) asked.push(paidBy);
        const left = { count: paidBy === undefined ? 0 : own };
        return {
          execute: (operation, request) =>
            left.count-- > 0 ? Effect.succeed(reply) : server.execute(operation, request),
          token: Effect.succeed(paidBy ?? "server"),
          defer: (error) => Effect.succeed(error),
        };
      }),
    }),
  );
  return { asked, layer };
};

describe("sync-stars consumer for signed-in users", () => {
  it("runs a signed-in user's sync on their gate, and bills the line only for what fell back to the server", async () => {
    const { queues } = recordingQueues();
    const line = recordingLine();
    const users = userGates(5);
    const batch = batchOf("sync-stars", [{ login: "octocat", mode: "full", reserved: 0, userId: "user-ada" }]);
    const result = await syncing(sending(7), line, [], users.layer)(queues, batch);
    expect(users.asked).toEqual([UserId.make("user-ada")]);
    expect(line.adjusted).toEqual([{ line: "all", units: 2 }]);
    expect(result.explicitAcks).toEqual(["m0"]);
  });

  it("runs the syncs of a batch at once, so a user's sync never waits behind the server's", async () => {
    const { queues } = recordingQueues();
    const userDone = Effect.runSync(Deferred.make<void>());
    const layer = Layer.mock(StarSync.StarSync, {
      syncLogin: (request) =>
        request.userId === undefined
          ? Effect.as(Deferred.await(userDone), report)
          : Effect.as(Deferred.succeed(userDone, undefined), report),
    });
    const batch = batchOf("sync-stars", [
      { login: "octocat", mode: "full" },
      { login: "ada", mode: "full", userId: "user-ada" },
    ]);
    const result = await syncing(layer, recordingLine(), [], userGates(0).layer)(queues, batch);
    expect(result.explicitAcks.toSorted()).toEqual(["m0", "m1"]);
  });
});

describe("user gates", () => {
  const remoteReply = { _tag: "Replied", status: 200, headers: {}, body: "{}" };

  const wired = (read: Effect.Effect<Redacted.Redacted<string>, AuthFailed>) => {
    const reads = { count: 0 };
    const calls: Array<{ readonly name: string; readonly token: string }> = [];
    const namespace = {
      getByName: (name: string) => ({
        execute: (_request: TokenGate.RemoteRequest, token: string) =>
          Effect.sync(() => {
            calls.push({ name, token });
            return remoteReply;
          }),
      }),
    } as unknown as Effect.Success<typeof UserGitHubGate>;
    const tokens = Layer.succeed(
      GitHubTokens,
      GitHubTokens.of({
        read: () =>
          Effect.andThen(
            Effect.sync(() => reads.count++),
            read,
          ),
      }),
    );
    const layer = UserGate.layer(namespace).pipe(Layer.provide(Layer.merge(tokens, runtimeContext)));
    return { reads, calls, layer };
  };

  const twoRequests = (server: TokenGate.TokenGate["Service"]) =>
    Effect.gen(function* () {
      const gate = yield* (yield* UserGate.UserGates)
        .forJob({ paidBy: UserId.make("user-ada") })
        .pipe(Effect.provideService(TokenGate.TokenGate, server));
      const request = HttpClientRequest.get("https://api.github.com/users/octocat/starred");
      return yield* Effect.all([gate.execute("list-stars", request), gate.execute("list-stars", request)]);
    });

  it("reads the user's token once a job and sends each request to that user's object with it", async () => {
    const { reads, calls, layer } = wired(Effect.succeed(Redacted.make("gho_ada")));
    const sent = { count: 0 };
    const server = TokenGate.TokenGate.of({
      execute: () =>
        Effect.as(
          Effect.sync(() => sent.count++),
          reply,
        ),
    });
    const replies = await Effect.runPromise(twoRequests(server).pipe(Effect.provide(layer)));
    expect(replies.map((each) => each.status)).toEqual([200, 200]);
    expect(reads.count).toBe(1);
    expect(calls).toEqual([
      { name: "user-ada", token: "gho_ada" },
      { name: "user-ada", token: "gho_ada" },
    ]);
    expect(sent.count).toBe(0);
  });

  it("shares one token read between a user's jobs that run at once, so they never refresh it twice", async () => {
    const { reads, calls, layer } = wired(Effect.succeed(Redacted.make("gho_ada")));
    const sent = { count: 0 };
    const server = TokenGate.TokenGate.of({
      execute: () =>
        Effect.as(
          Effect.sync(() => sent.count++),
          reply,
        ),
    });
    const replies = await Effect.runPromise(
      Effect.all([twoRequests(server), twoRequests(server)], { concurrency: "unbounded" }).pipe(Effect.provide(layer)),
    );
    expect(replies.flat().map((each) => each.status)).toEqual([200, 200, 200, 200]);
    expect(reads.count).toBe(1);
    expect(calls).toHaveLength(4);
    expect(sent.count).toBe(0);
  });

  it("gives work no signed-in user started the server's gate, and reads no token for it", async () => {
    const { reads, calls, layer } = wired(Effect.succeed(Redacted.make("gho_ada")));
    const server = TokenGate.TokenGate.of({ execute: () => Effect.succeed(reply) });
    const gate = await Effect.runPromise(
      UserGate.UserGates.use((users) => users.forJob({}).pipe(Effect.provideService(TokenGate.TokenGate, server))).pipe(
        Effect.provide(layer),
      ),
    );
    expect(
      await Effect.runPromise(
        gate.execute("list-stars", HttpClientRequest.get("https://api.github.com/users/octocat/starred")),
      ),
    ).toEqual(reply);
    expect(reads.count).toBe(0);
    expect(calls).toEqual([]);
  });

  it("moves a job to the server's token when the user's token cannot be read, and never asks the object", async () => {
    const { reads, calls, layer } = wired(Effect.fail(new AuthFailed({ operation: "token", cause: "no account" })));
    const sent = { count: 0 };
    const server = TokenGate.TokenGate.of({
      execute: () =>
        Effect.as(
          Effect.sync(() => sent.count++),
          reply,
        ),
    });
    await Effect.runPromise(twoRequests(server).pipe(Effect.provide(layer)));
    expect(reads.count).toBe(1);
    expect(calls).toEqual([]);
    expect(sent.count).toBe(2);
  });
});

describe("enrich-repo consumer for signed-in users", () => {
  it("reads each signed-in user's repos on that user's gate, and settles every message in place", async () => {
    const { queues, later } = recordingQueues();
    const owners = new Map<TokenGate.TokenGate["Service"], UserId>();
    const users = Layer.succeed(
      UserGate.UserGates,
      UserGate.UserGates.of({
        forJob: Effect.fn("UserGates.forJob")(function* ({ paidBy }) {
          const server = yield* TokenGate.TokenGate;
          const gate: UserGate.JobGate = {
            ...(paidBy === undefined ? server : TokenGate.TokenGate.of({ execute: () => Effect.succeed(reply) })),
            token: Effect.succeed(paidBy ?? "server"),
            defer: (error) => Effect.succeed(error),
          };
          if (paidBy !== undefined) owners.set(gate, paidBy);
          return gate;
        }),
      }),
    );
    const asked: Array<readonly [string, ReadonlyArray<RepoId>]> = [];
    const enrichers = Layer.effect(
      EnrichRepo.EnrichRepo,
      Effect.map(TokenGate.TokenGate, (gate) =>
        EnrichRepo.EnrichRepo.of({
          enrichRepos: (ids) => {
            const paidBy = owners.get(gate) ?? "server";
            asked.push([paidBy, ids]);
            return paidBy === "user-grace"
              ? Effect.flatMap(inMillis(60_000), (resetAt) =>
                  Effect.fail(new TokenBudgetExhausted({ resource: "graphql", resetAt })),
                )
              : Effect.succeed(ids.map((id) => EnrichRepo.Enrichment.Unchanged({ id })));
          },
        }),
      ),
    );
    const batch = batchOf("enrich-repo", [
      { repoId: 1, userId: "user-ada" },
      { repoId: 2 },
      { repoId: 3, userId: "user-ada" },
      { repoId: 4, userId: "user-grace" },
    ]);
    const result = await run(
      Settle.processBatch(EnrichRepoConsumer.pipeline(enrichers), queues, batch.messages).pipe(
        Effect.provide(Layer.merge(answering, users)),
      ),
      batch,
    );
    expect(asked).toEqual([
      ["user-ada", [1, 3]],
      ["server", [2]],
      ["user-grace", [4]],
    ]);
    expect(later.map((sent) => sent.body)).toEqual([{ repoId: 4, userId: "user-grace" }]);
    expect(result.explicitAcks.toSorted()).toEqual(["m0", "m1", "m2", "m3"]);
    expect(result.retryMessages).toEqual([]);
  });
});
