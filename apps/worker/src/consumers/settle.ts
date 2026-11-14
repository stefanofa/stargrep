import type * as Cloudflare from "@alchemy.run/cloudflare";
import type { FetchIcon } from "@stargrep/core/icons";
import { EnrichRepo } from "@stargrep/core/repos";
import type { StarSync } from "@stargrep/core/stars";
import { isPermanent } from "@stargrep/github/errors";
import * as TokenGate from "@stargrep/github/token-gate";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
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

type Reason = Failure["_tag"] | "SchemaError" | "Stale" | "Deadline";

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
    RateLimited: (failure) =>
      Settlement.Defer({ error: failure._tag, until: failure.deferredUntil ?? now + failure.retryAfterMillis }),
    Unauthorized: deadLetter,
    GitHubTokenMissing: deadLetter,
    AiKeyMissing: deadLetter,
    AccountNotFound: deadLetter,
    EmbeddingModelMismatch: deadLetter,
    // The login, repo, or README is gone. EnrichRepo has already counted a repo's own failure, so the sweep,
    // not the queue, sends the repo again after its backoff.
    NotFound: deadLetter,
    GitHubRequestFailed: (failure) => (isPermanent(failure) ? deadLetter(failure) : retry(failure)),
    GitHubResponseInvalid: (failure) => (isPermanent(failure) ? deadLetter(failure) : retry(failure)),
    // A conflict or a constraint error can come from a race with another message's writes. A query error repeats.
    DbQueryFailed: (failure) => (failure.reason === "query" ? deadLetter(failure) : retry(failure)),
    DbRowInvalid: deadLetter,
    EnrichQueueFailed: retry,
    BlobStoreFailed: retry,
    AiModelNotFound: deadLetter,
    // EnrichRepo counts a summary answer that does not decode and backs its repo off, so the sweep, not the queue, sends
    // the repo again. A queue retry of a repo that just reached the cap would pay again. An embedding answer counts
    // against no repo, and a second one can decode.
    AiOutputInvalid: (failure) => (EnrichRepo.ownError(failure) ? deadLetter(failure) : retry(failure)),
    // EnrichRepo has capped a refused repo, so neither the queue nor the sweep sends it again.
    AiRefused: deadLetter,
    // EnrichRepo has counted a refused answer, or left a lost save holding its lease, so the sweep, not the queue, sends
    // the repo again. A queue retry of a repo that just reached the cap would pay again.
    AnswerNotSaved: deadLetter,
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

// Alchemy acks every message of a batch once its handler returns, and retries every one when the handler fails, even
// a message the handler already settled. The first ack or retry wins and later calls do nothing, so the queue sees one
// call per message. A message the handler never settled takes Alchemy's call.
export const settleOnce = (message: Message): Message => {
  const ack = message.ack.bind(message);
  const retry = message.retry.bind(message);
  let settled = false;
  const once = (call: () => void) => {
    if (settled) return;
    settled = true;
    call();
  };
  message.ack = () => once(ack);
  message.retry = (options) => once(() => retry(options));
  return message;
};

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

export interface Chunks<A> {
  readonly size: number;
  // How long after the batch starts a chunk may still run. A chunk still running then stops, and its messages and
  // every later one retry, well before Cloudflare ends the invocation at 15 minutes.
  readonly deadline: Duration.Duration;
  // A known token can skip later chunks. Jobs that select a token at runtime cache the resolved token in their gate.
  readonly gate: (body: A) => string | undefined;
}

export interface Pipeline<A, R, D = never> {
  readonly decode: (body: unknown) => Result.Result<A, Schema.SchemaError>;
  readonly run: (
    deliveries: ReadonlyArray<Delivery<A>>,
  ) => Effect.Effect<ReadonlyArray<Result.Result<Settlement, Failure>>, never, R>;
  readonly describe: (body: A) => Record<string, unknown>;
  // Records a dead letter's outcome. A failure retries the dead letter, so the outcome is never lost to an outage.
  readonly onDeadLetter: (body: A) => Effect.Effect<void, Failure, D>;
  // The body a deferred message goes out again with. None sends the body it arrived with.
  readonly resend: (body: A) => Option.Option<unknown>;
  // Runs and settles the batch a chunk at a time, so a slow chunk never holds back the messages before it. None runs
  // the whole batch as one chunk.
  readonly chunks: Option.Option<Chunks<A>>;
}

export const pipeline = <S extends Schema.Decoder<unknown>, R, D = never>(options: {
  readonly schema: S;
  readonly run: Pipeline<S["Type"], R>["run"];
  readonly describe: Pipeline<S["Type"], R>["describe"];
  readonly onDeadLetter?: Pipeline<S["Type"], R, D>["onDeadLetter"];
  readonly resend?: Pipeline<S["Type"], R>["resend"];
  readonly chunks?: Chunks<S["Type"]>;
}): Pipeline<S["Type"], R, D> => ({
  decode: Schema.decodeUnknownResult(options.schema),
  run: options.run,
  describe: options.describe,
  onDeadLetter: options.onDeadLetter ?? (() => Effect.void),
  resend: options.resend ?? (() => Option.none()),
  chunks: Option.fromNullishOr(options.chunks),
});

// Fresh, because a nested provide reuses the layers the runtime already built, such as GitHub on the server's gate.
export const onGate = <A, E, R>(layer: Layer.Layer<A, E, R>, gate: TokenGate.TokenGate["Service"]) =>
  Layer.fresh(layer.pipe(Layer.provide(Layer.succeed(TokenGate.TokenGate, gate))));

export const processBatch = Effect.fn("Consumer.processBatch")(function* <A, R, D>(
  pipeline: Pipeline<A, R, D>,
  queues: Queues,
  messages: ReadonlyArray<Message>,
) {
  const started = yield* Clock.currentTimeMillis;
  const deadline = Option.map(pipeline.chunks, (chunks) => started + Duration.toMillis(chunks.deadline));
  const gateOf = Option.match(pipeline.chunks, { onNone: () => () => "", onSome: (chunks) => chunks.gate });
  const waits = new Map<string, Settlement>();
  const waitFor = (body: A) => {
    const key = gateOf(body);
    return key === undefined ? undefined : waits.get(key);
  };
  const decoded = messages.map((message) => ({ message, body: pipeline.decode(message.body) }));
  const valid = decoded.flatMap(({ message, body }) =>
    Result.isSuccess(body) ? [{ message, body: body.success }] : [],
  );

  const runUntilDeadline = <X>(run: Effect.Effect<X, never, R>) =>
    Option.match(deadline, {
      onNone: () => Effect.asSome(run),
      onSome: (at) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          now < at ? Effect.timeoutOption(run, Duration.millis(at - now)) : Effect.succeedNone,
        ),
    });

  const settleChunk = Effect.fnUntraced(function* (
    chunk: ReadonlyArray<{ readonly message: Message; readonly body: A }>,
  ) {
    const waiting = chunk.flatMap((entry) => {
      const wait = waitFor(entry.body);
      return wait === undefined ? [] : [{ ...entry, settlement: wait }];
    });
    const ready = chunk.filter(({ body }) => waitFor(body) === undefined);
    const outcomes = yield* runUntilDeadline(
      pipeline.run(ready.map(({ message, body }) => ({ body, attempts: message.attempts }))),
    );
    if (Option.isSome(outcomes) && outcomes.value.length !== ready.length) {
      return yield* Effect.die(`A pipeline returned ${outcomes.value.length} outcomes for ${ready.length} bodies`);
    }
    const now = yield* Clock.currentTimeMillis;
    const settlements = Option.match(outcomes, {
      onNone: () => ready.map(() => Settlement.Retry({ error: "Deadline" })),
      onSome: (settled) =>
        settled.map((outcome) =>
          Result.match(outcome, { onSuccess: (done) => done, onFailure: (error) => afterFailure(error, now) }),
        ),
    });
    const ran = Arr.zipWith(ready, settlements, (entry, settlement) => ({ ...entry, settlement }));
    for (const { body, settlement } of ran) {
      const key = gateOf(body);
      if (settlement._tag === "Defer" && key !== undefined) waits.set(key, settlement);
    }
    yield* Effect.forEach([...ran, ...waiting], ({ message, body, settlement }) =>
      settle(
        queues,
        message,
        settlement,
        now,
        Option.getOrElse(pipeline.resend(body), () => message.body),
      ),
    );
  });

  const chunks = Option.match(pipeline.chunks, {
    onNone: () => [valid],
    onSome: ({ size }) => Arr.chunksOf(valid, size),
  });
  yield* Effect.forEach(chunks, settleChunk, { discard: true });
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.forEach(
    decoded.flatMap(({ message, body }) => (Result.isFailure(body) ? [message] : [])),
    (message) => settle(queues, message, Settlement.DeadLetter({ error: "SchemaError" }), now),
  );
});

const bodyType = (body: unknown) => ({
  bodyType: body === null ? "null" : Array.isArray(body) ? "array" : typeof body,
});

// A dead-letter queue has no dead-letter queue of its own, so a dead letter whose outcome still fails to record on its
// last attempt is logged and acked.
export const handleDeadLetters = <A, R, D>(name: string, pipeline: Pipeline<A, R, D>, maxRetries: number) =>
  Stream.runForEach(
    Effect.fn("DeadLetters.handle")(function* (message: Message) {
      const decoded = pipeline.decode(message.body);
      const fields = { queue: name, messageId: message.id, attempts: message.attempts };
      yield* Effect.logError("Dead letter", {
        ...fields,
        ...(Result.isSuccess(decoded) ? pipeline.describe(decoded.success) : bodyType(message.body)),
      });
      const recorded = Result.isSuccess(decoded)
        ? yield* Effect.result(pipeline.onDeadLetter(decoded.success))
        : Result.void;
      if (Result.isSuccess(recorded)) return message.ack();
      if (message.attempts > maxRetries) {
        message.ack();
        return yield* Effect.logError("Dead letter dropped unrecorded", { ...fields, error: recorded.failure._tag });
      }
      message.retry();
      yield* Effect.logWarning("Dead letter not recorded, retrying", { ...fields, error: recorded.failure._tag });
    }),
  );
