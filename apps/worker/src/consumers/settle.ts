import type * as Cloudflare from "@alchemy.run/cloudflare";
import type { EnrichRepo } from "@stargrep/core/repos";
import type { StarSync } from "@stargrep/core/stars";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Layers from "../layers.ts";

type Message = Cloudflare.Queues.Message<unknown>;

export type Failure = StarSync.StarSyncError | EnrichRepo.EnrichRepoError | EnrichRepo.EnrichRepoAbort;

type Reason = Failure["_tag"] | "SchemaError" | "Stale";

export type Settlement = Data.TaggedEnum<{
  Done: Record<never, never>;
  Retry: { readonly error: Reason };
  Defer: { readonly error: Reason; readonly until: number };
  DeadLetter: { readonly error: Reason };
}>;
export const Settlement = Data.taggedEnum<Settlement>();

const retry = (error: Failure) => Settlement.Retry({ error: error._tag });
const deadLetter = (error: Failure) => Settlement.DeadLetter({ error: error._tag });

export const afterFailure = (error: Failure, now: number): Settlement =>
  Match.valueTags(error, {
    TokenBudgetExhausted: (failure) => Settlement.Defer({ error: failure._tag, until: failure.resetAt }),
    RateLimited: (failure) => Settlement.Defer({ error: failure._tag, until: now + failure.retryAfterMillis }),
    Unauthorized: deadLetter,
    GitHubTokenMissing: deadLetter,
    AiKeyMissing: deadLetter,
    AccountNotFound: deadLetter,
    EmbeddingModelMismatch: deadLetter,
    // The login, repo, or README is gone. The dead-letter consumer counts a repo's failure, and the sweep
    // sends the repo again after a backoff until it reaches the cap.
    NotFound: deadLetter,
    // GraphQL errors other than NOT_FOUND and RATE_LIMITED include GitHub's transient INTERNAL errors.
    // A 403 can be a rate limit GitHub words in a way the client does not recognize, so it gets the queue's retries.
    GitHubRequestFailed: (failure) =>
      failure.reason === "status" && failure.status !== null && failure.status < 500 && failure.status !== 403
        ? deadLetter(failure)
        : retry(failure),
    // A body that broke while it was read can arrive whole next time. A body with the wrong shape cannot.
    GitHubResponseInvalid: (failure) => (failure.reason === "unreadable-body" ? retry(failure) : deadLetter(failure)),
    // A conflict or a constraint error can come from a race with another message's writes. A query error repeats.
    DbQueryFailed: (failure) => (failure.reason === "query" ? deadLetter(failure) : retry(failure)),
    DbRowInvalid: deadLetter,
    EnrichQueueFailed: retry,
    BlobStoreFailed: retry,
    AiModelNotFound: deadLetter,
    // Model output varies from call to call, so a second answer can decode.
    AiOutputInvalid: retry,
    AiTimeout: retry,
    AiUnavailable: retry,
    // The SDK marks this not retryable, such as a 400 for the request itself.
    AiRequestFailed: deadLetter,
  });

const maxDelaySeconds = 12 * 60 * 60;
const resetMarginSeconds = 5;

export const delaySeconds = (until: number, now: number) =>
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

export const bindQueues = Effect.fn("Consumer.bindQueues")(function* (
  name: string,
  self: Cloudflare.Queues.WriteQueueClient,
  deadLetters: Cloudflare.Queues.WriteQueueClient,
) {
  const run = yield* Layers.inRuntime;
  return {
    name,
    // Alchemy's SendOptions has no delaySeconds, so a delayed send goes through the raw binding.
    sendLater: (body, delay) =>
      run(Effect.flatMap(self.raw, (raw) => Effect.tryPromise(() => raw.send(body, { delaySeconds: delay })))).pipe(
        Effect.mapError((cause) => new QueueSendFailed({ queue: name, cause })),
      ),
    deadLetter: (body) =>
      run(deadLetters.send(body)).pipe(
        Effect.mapError((cause) => new QueueSendFailed({ queue: `${name} dead letters`, cause })),
      ),
  } satisfies Queues;
});

const sendOrRetry = Effect.fn("Consumer.sendOrRetry")(function* (
  send: Effect.Effect<void, QueueSendFailed>,
  message: Message,
  fields: Record<string, unknown>,
  delay?: number,
) {
  const sent = yield* Effect.result(send);
  if (Result.isFailure(sent)) {
    message.retry(delay === undefined ? undefined : { delaySeconds: delay });
    return yield* Effect.logWarning("Queue send failed, so the message retries", {
      ...fields,
      sendError: sent.failure._tag,
    });
  }
  message.ack();
});

export const settle = Effect.fn("Consumer.settle")(function* (
  queues: Queues,
  message: Message,
  settlement: Settlement,
  now: number,
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
      const delay = delaySeconds(settlement.until, now);
      yield* Effect.logInfo("Queue message deferred", { ...fields, error: settlement.error, delay });
      return yield* sendOrRetry(queues.sendLater(message.body, delay), message, fields, delay);
    }
    case "DeadLetter":
      yield* Effect.logWarning("Queue message dead-lettered", { ...fields, error: settlement.error });
      return yield* sendOrRetry(queues.deadLetter(message.body), message, fields);
  }
});

export interface Pipeline<A, R, D = never> {
  readonly decode: (body: unknown) => Result.Result<A, Schema.SchemaError>;
  readonly run: (
    bodies: ReadonlyArray<A>,
  ) => Effect.Effect<ReadonlyArray<Result.Result<Settlement, Failure>>, never, R>;
  readonly describe: (body: A) => Record<string, unknown>;
  readonly onDeadLetter: (body: A) => Effect.Effect<void, never, D>;
}

export const pipeline = <S extends Schema.Decoder<unknown>, R, D = never>(options: {
  readonly schema: S;
  readonly run: Pipeline<S["Type"], R>["run"];
  readonly describe: Pipeline<S["Type"], R>["describe"];
  readonly onDeadLetter?: Pipeline<S["Type"], R, D>["onDeadLetter"];
}): Pipeline<S["Type"], R, D> => ({
  decode: Schema.decodeUnknownResult(options.schema),
  run: options.run,
  describe: options.describe,
  onDeadLetter: options.onDeadLetter ?? (() => Effect.void),
});

export const processBatch = Effect.fn("Consumer.processBatch")(function* <A, R, D>(
  pipeline: Pipeline<A, R, D>,
  queues: Queues,
  messages: ReadonlyArray<Message>,
) {
  const decoded = messages.map((message) => ({ message, body: pipeline.decode(message.body) }));
  const valid = decoded.flatMap(({ message, body }) =>
    Result.isSuccess(body) ? [{ message, body: body.success }] : [],
  );
  const outcomes = yield* pipeline.run(valid.map(({ body }) => body));
  if (outcomes.length !== valid.length) {
    return yield* Effect.die(`A pipeline returned ${outcomes.length} outcomes for ${valid.length} bodies`);
  }
  const now = yield* Clock.currentTimeMillis;
  const undecodable = decoded.flatMap(({ message, body }) =>
    Result.isFailure(body) ? [{ message, settlement: Settlement.DeadLetter({ error: "SchemaError" }) }] : [],
  );
  const settled = Arr.zipWith(valid, outcomes, ({ message }, outcome) => ({
    message,
    settlement: Result.match(outcome, { onSuccess: (done) => done, onFailure: (error) => afterFailure(error, now) }),
  }));
  yield* Effect.forEach([...undecodable, ...settled], ({ message, settlement }) =>
    settle(queues, message, settlement, now),
  );
});

const bodyType = (body: unknown) => ({
  bodyType: body === null ? "null" : Array.isArray(body) ? "array" : typeof body,
});

export const handleDeadLetters = <A, R, D>(name: string, pipeline: Pipeline<A, R, D>) =>
  Stream.runForEach(
    Effect.fn("DeadLetters.handle")(function* (message: Message) {
      const decoded = pipeline.decode(message.body);
      yield* Effect.logError("Dead letter", {
        queue: name,
        messageId: message.id,
        attempts: message.attempts,
        ...(Result.isSuccess(decoded) ? pipeline.describe(decoded.success) : bodyType(message.body)),
      });
      if (Result.isSuccess(decoded)) yield* pipeline.onDeadLetter(decoded.success);
    }),
  );
