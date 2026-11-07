// @effect-diagnostics effectFnOpportunity:off - the fakes here return fixed effects.
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { RateLine } from "@stargrep/core/limits";
import { StarSync } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import { DbQueryFailed } from "@stargrep/db/errors";
import { BudgetShare, RepoId } from "@stargrep/github/schemas";
import * as TokenGate from "@stargrep/github/token-gate";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Settle from "../src/consumers/settle.ts";
import * as SyncStarsConsumer from "../src/consumers/sync-stars.ts";
import * as UserGate from "../src/user-gate.ts";

export const report = { listed: 1, added: 1, unchanged: 0, unstarred: 0, enqueued: 1, shifted: false };
export const repoId = Schema.decodeSync(RepoId);
export const share = BudgetShare.make(0.5);
export const inMillis = (millis: number) => Effect.map(Clock.currentTimeMillis, (now) => now + millis);

export const recordingQueues = (fail = false) => {
  const later: Array<{ readonly body: unknown; readonly delaySeconds: number }> = [];
  const deadLetters: Array<unknown> = [];
  const failure = new Settle.QueueSendFailed({ queue: "test", cause: new Error("queue down") });
  const queues: Settle.Queues = {
    name: "test",
    sendLater: (body, delaySeconds) =>
      fail ? Effect.fail(failure) : Effect.sync(() => void later.push({ body, delaySeconds })),
    deadLetter: (body) => (fail ? Effect.fail(failure) : Effect.sync(() => void deadLetters.push(body))),
  };
  return { later, deadLetters, queues };
};

export const batchOf = (queue: string, bodies: ReadonlyArray<unknown>, attempts = 1) =>
  createMessageBatch(
    queue,
    bodies.map((body, index) => ({ id: `m${index}`, timestamp: 0, attempts, body })),
  );

export const run = async <E>(effect: Effect.Effect<void, E>, batch: MessageBatch) => {
  const ctx = createExecutionContext();
  await Effect.runPromise(effect);
  return getQueueResult(batch, ctx);
};

const unit = Duration.toMillis(RateLine.durationOf(RateLine.githubAll(share).rate, 1));

// Records each move of a line, in units of githubAll at the test share.
export const recordingLine = (fail = false) => {
  const adjusted: Array<{ readonly line: string; readonly units: number }> = [];
  const layer = Layer.succeed(
    Db.Db,
    Db.Db.of({
      rateLines: {
        adjust: (line: Db.LineKey, _: DateTime.Utc, by: Duration.Duration) =>
          fail
            ? Effect.fail(new DbQueryFailed({ operation: "rateLines.adjust", reason: "transport", sqlState: null }))
            : Effect.sync(() => void adjusted.push({ line, units: Duration.toMillis(by) / unit })),
      },
    } as unknown as Db.Db["Service"]),
  );
  return { adjusted, layer };
};

export const reply: TokenGate.Reply = {
  status: 200,
  headers: Headers.fromInput({}),
  body: Option.some("{}"),
  rateLimit: { resource: Option.none(), limit: Option.none(), remaining: Option.none(), resetAt: Option.none() },
};

export const answering = Layer.succeed(
  TokenGate.TokenGate,
  TokenGate.TokenGate.of({ execute: Effect.fn("TokenGate.execute")(() => Effect.succeed(reply)) }),
);

// A sync that sends count requests through the token gate, then ends as outcome does.
export const sending = (
  count: number,
  outcome: Effect.Effect<StarSync.SyncReport, StarSync.StarSyncError> = Effect.succeed(report),
) =>
  Layer.effect(
    StarSync.StarSync,
    Effect.map(TokenGate.TokenGate, (gate) => {
      const run = Effect.forEach(
        Array.from({ length: count }),
        () => gate.execute("owner", HttpClientRequest.get("https://api.github.com/users/octocat")),
        { discard: true },
      ).pipe(Effect.orDie, Effect.andThen(outcome));
      return StarSync.StarSync.of({ syncLogin: () => run });
    }),
  );

export const syncing =
  (
    syncs: Layer.Layer<StarSync.StarSync, never, TokenGate.TokenGate>,
    line = recordingLine(),
    logs: Array<unknown> = [],
    users: Layer.Layer<UserGate.UserGates> = UserGate.layerServerOnly,
  ) =>
  (queues: Settle.Queues, batch: MessageBatch) =>
    run(
      Settle.processBatch(SyncStarsConsumer.pipeline(share, syncs), queues, batch.messages).pipe(
        Effect.provide(
          Layer.mergeAll(
            answering,
            users,
            line.layer,
            Logger.layer([Logger.make(({ message }) => logs.push(message))]),
          ),
        ),
      ),
      batch,
    );

export const runtimeContext = Layer.succeed(
  RuntimeContext,
  RuntimeContext.of({
    Type: "test",
    id: "test",
    env: {},
    get: () => Effect.undefined,
    set: (id) => Effect.succeed(id),
  }),
);
