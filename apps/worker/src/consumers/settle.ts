import type * as Cloudflare from "@alchemy.run/cloudflare";
import type { FetchIcon } from "@stargrep/core/icons";
import type { EnrichRepo } from "@stargrep/core/repos";
import type { StarSync } from "@stargrep/core/stars";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Layers from "../layers.ts";

type Message = Cloudflare.Queues.Message<unknown>;

export type Failure =
  | StarSync.StarSyncError
  | EnrichRepo.EnrichRepoError
  | EnrichRepo.EnrichRepoAbort
  | FetchIcon.FetchIconError
  | FetchIcon.BackfillError;

type Reason = Failure["_tag"] | "SchemaError" | "Stale";

export type Settlement = Data.TaggedEnum<{
  Done: Record<never, never>;
  Retry: { readonly error: Reason };
  RetryLater: { readonly error: Reason; readonly until: number };
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
    // The login, repo, or README is gone. EnrichRepo has already counted a repo's own failure, so the sweep,
    // not the queue, sends the repo again after its backoff.
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
    // A raw.githubusercontent.com 429 can come from another tenant on the same egress IP, so it waits and never
    // becomes "no icon". The wait spends a queue retry, so a host that keeps answering 429 dead-letters.
    IconFetchFailed: (failure) =>
      failure.retryAfterMillis !== null
        ? Settlement.RetryLater({ error: failure._tag, until: now + failure.retryAfterMillis })
        : retry(failure),
    IconStoreFailed: retry,
    IconQueueFailed: retry,
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

// resend is the body a deferred message goes out again with, by default the one it arrived with.
export const settle = Effect.fn("Consumer.settle")(function* (
  queues: Queues,
  message: Message,
  settlement: Settlement,
  now: number,
  resend: unknown = message.body,
) {
  const fields = { queue: queues.name, messageId: message.id, attempts: message.attempts };
  switch (settlement._tag) {
    case "Done":
      message.ack();
      return yield* Effect.logInfo("Queue message done", fields);
    case "Retry":
      message.retry();
      return yield* Effect.logWarning("Queue message failed, retrying", { ...fields, error: settlement.error });
    case "RetryLater": {
      const delay = delaySeconds(settlement.until, now);
      message.retry({ delaySeconds: delay });
      return yield* Effect.logWarning("Queue message failed, retrying later", {
        ...fields,
        error: settlement.error,
        delay,
      });
    }
    case "Defer": {
      const delay = delaySeconds(settlement.until, now);
      yield* Effect.logInfo("Queue message deferred", { ...fields, error: settlement.error, delay });
      return yield* sendOrRetry(queues.sendLater(resend, delay), message, fields, delay);
    }
    case "DeadLetter":
      yield* Effect.logWarning("Queue message dead-lettered", { ...fields, error: settlement.error });
      return yield* sendOrRetry(queues.deadLetter(message.body), message, fields);
  }
});

// A decoded body and how many times the queue has delivered it, 1 on its first delivery.
export interface Delivery<A> {
  readonly body: A;
  readonly attempts: number;
}

export interface Pipeline<A, R, D = never> {
  readonly decode: (body: unknown) => Result.Result<A, Schema.SchemaError>;
  readonly run: (
    deliveries: ReadonlyArray<Delivery<A>>,
  ) => Effect.Effect<ReadonlyArray<Result.Result<Settlement, Failure>>, never, R>;
  readonly describe: (body: A) => Record<string, unknown>;
  readonly onDeadLetter: (body: A) => Effect.Effect<void, never, D>;
  // The body a deferred message goes out again with. None sends the body it arrived with.
  readonly resend: (body: A) => Option.Option<unknown>;
}

export const pipeline = <S extends Schema.Decoder<unknown>, R, D = never>(options: {
  readonly schema: S;
  readonly run: Pipeline<S["Type"], R>["run"];
  readonly describe: Pipeline<S["Type"], R>["describe"];
  readonly onDeadLetter?: Pipeline<S["Type"], R, D>["onDeadLetter"];
  readonly resend?: Pipeline<S["Type"], R>["resend"];
}): Pipeline<S["Type"], R, D> => ({
  decode: Schema.decodeUnknownResult(options.schema),
  run: options.run,
  describe: options.describe,
  onDeadLetter: options.onDeadLetter ?? (() => Effect.void),
  resend: options.resend ?? (() => Option.none()),
});

// Fresh, because a nested provide reuses the layers the runtime already built, such as GitHub on the server's gate.
export const onGate = <A, E, R>(layer: Layer.Layer<A, E, R>, gate: TokenGate.TokenGate["Service"]) =>
  Layer.fresh(layer.pipe(Layer.provide(Layer.succeed(TokenGate.TokenGate, gate))));

export const processBatch = Effect.fn("Consumer.processBatch")(function* <A, R, D>(
  pipeline: Pipeline<A, R, D>,
  queues: Queues,
  messages: ReadonlyArray<Message>,
) {
  const decoded = messages.map((message) => ({ message, body: pipeline.decode(message.body) }));
  const valid = decoded.flatMap(({ message, body }) =>
    Result.isSuccess(body) ? [{ message, body: body.success }] : [],
  );
  const outcomes = yield* pipeline.run(valid.map(({ message, body }) => ({ body, attempts: message.attempts })));
  if (outcomes.length !== valid.length) {
    return yield* Effect.die(`A pipeline returned ${outcomes.length} outcomes for ${valid.length} bodies`);
  }
  const now = yield* Clock.currentTimeMillis;
  const undecodable = decoded.flatMap(({ message, body }) =>
    Result.isFailure(body)
      ? [{ message, settlement: Settlement.DeadLetter({ error: "SchemaError" }), resend: message.body }]
      : [],
  );
  const settled = Arr.zipWith(valid, outcomes, ({ message, body }, outcome) => ({
    message,
    settlement: Result.match(outcome, { onSuccess: (done) => done, onFailure: (error) => afterFailure(error, now) }),
    resend: Option.getOrElse(pipeline.resend(body), () => message.body),
  }));
  yield* Effect.forEach([...undecodable, ...settled], ({ message, settlement, resend }) =>
    settle(queues, message, settlement, now, resend),
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
