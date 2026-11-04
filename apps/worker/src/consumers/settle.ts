import type * as Cloudflare from "@alchemy.run/cloudflare";
import type { EnrichRepo } from "@stargrep/core/repos";
import type { StarSync } from "@stargrep/core/stars";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export type Message = Cloudflare.Queues.Message<unknown>;

export type Settlement = Data.TaggedEnum<{
  Done: Record<never, never>;
  Retry: { readonly error: string };
  Defer: { readonly error: string; readonly until: number };
  DeadLetter: { readonly error: string };
}>;
export const Settlement = Data.taggedEnum<Settlement>();

export type Failure = StarSync.StarSyncError | EnrichRepo.EnrichRepoError | EnrichRepo.EnrichRepoAbort;

export const afterFailure = (error: Failure, now: number): Settlement => {
  switch (error._tag) {
    case "TokenBudgetExhausted":
      return Settlement.Defer({ error: error._tag, until: error.resetAt });
    case "RateLimited":
      return Settlement.Defer({ error: error._tag, until: now + error.retryAfterMillis });
    default:
      return Settlement.Retry({ error: error._tag });
  }
};

const maxDelaySeconds = 12 * 60 * 60;
const resetMarginSeconds = 5;

const delaySeconds = (until: number, now: number) =>
  Math.min(maxDelaySeconds, Math.max(1, Math.ceil((until - now) / 1000) + resetMarginSeconds));

export class QueueSendFailed extends Schema.TaggedError<QueueSendFailed, { readonly brand: unique symbol }>()(
  "QueueSendFailed",
  {
    queue: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Sending a message to '${this.queue}' failed`;
  }
}

export interface Queues {
  readonly name: string;
  readonly sendLater: (body: unknown, delaySeconds: number) => Effect.Effect<void, QueueSendFailed>;
  readonly deadLetter: (body: unknown) => Effect.Effect<void, QueueSendFailed>;
}

export const settle = Effect.fn("Consumer.settle")(function* (
  queues: Queues,
  message: Message,
  settlement: Settlement,
) {
  const fields = { queue: queues.name, messageId: message.id, attempts: message.attempts };
  switch (settlement._tag) {
    case "Done":
      message.ack();
      return yield* Effect.logInfo("Queue message done", fields);
    case "Retry":
      message.retry();
      return yield* Effect.logWarning("Queue message failed, retrying", { ...fields, error: settlement.error });
    case "Defer": {
      const delay = delaySeconds(settlement.until, yield* Clock.currentTimeMillis);
      const sent = yield* Effect.result(queues.sendLater(message.body, delay));
      if (sent._tag === "Failure") message.retry({ delaySeconds: delay });
      else message.ack();
      return yield* Effect.logInfo("Queue message deferred", { ...fields, error: settlement.error, delay });
    }
    case "DeadLetter": {
      const sent = yield* Effect.result(queues.deadLetter(message.body));
      if (sent._tag === "Failure") message.retry();
      else message.ack();
      return yield* Effect.logWarning("Queue message dead-lettered", { ...fields, error: settlement.error });
    }
  }
});

export const bodyType = (body: unknown) => ({
  bodyType: body === null ? "null" : Array.isArray(body) ? "array" : typeof body,
});

export const logDeadLetters = (name: string, describe: (body: unknown) => Record<string, unknown>) =>
  Stream.runForEach(
    Effect.fn("DeadLetters.log")(function* (message: Message) {
      yield* Effect.logError("Dead letter", {
        queue: name,
        messageId: message.id,
        attempts: message.attempts,
        ...describe(message.body),
      });
    }),
  );
