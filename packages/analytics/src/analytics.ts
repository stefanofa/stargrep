import type * as Brand from "effect/Brand";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import * as Predicate from "effect/Predicate";

// Who an event is about. The brands match @stargrep/db's, so a raw address can never pass for a caller key.
export type Actor = Data.TaggedEnum<{
  User: { readonly userId: string & Brand.Brand<"UserId"> };
  Network: { readonly caller: string & Brand.Brand<"CallerKey"> };
  // Work no visitor asked for in that moment, such as enrichment, a sweep, or a cron.
  Stargrep: {};
}>;
export const Actor = Data.taggedEnum<Actor>();

export type PlanSource = "keyword" | "cache" | "model" | "fallback";
export type SyncMode = "incremental" | "full";
// What the answer cache did for a search: served it fresh or stale, missed, or never cached it, such as another login's.
export type AnswerCache = "hit" | "stale" | "miss" | "none";

// One failure in an exception event. type is the error's tag or name, value its message, which Stargrep's errors build
// from bounded fields.
export interface Thrown {
  readonly type: string;
  readonly value: string;
  readonly stack: string | undefined;
}

// Every event Stargrep sends. None has a field for a query, a prompt, model output, a README, a token, or an address,
// so no caller can send one.
export type Event = Data.TaggedEnum<{
  SignedUp: {};
  MonthlyPicksOptedIn: {};
  MonthlyPicksOptedOut: {};
  StarsImportStarted: {
    // The starred total admission priced the import from, null before any lookup counted it.
    readonly stars: number | null;
    readonly signedIn: boolean;
    readonly mode: SyncMode;
    // Whether the login had never finished a sync.
    readonly first: boolean;
    readonly waitSeconds: number;
  };
  StarsImportFinished: {
    readonly listed: number;
    readonly added: number;
    readonly enqueued: number;
    readonly signedIn: boolean;
    readonly mode: SyncMode;
    readonly durationMillis: number;
    // From the trigger that queued the import to its end, waiting in line included.
    readonly sinceRequestMillis: number | null;
  };
  Search: {
    readonly planSource: PlanSource;
    readonly results: number;
    readonly latencyMillis: number;
    readonly answerCache: AnswerCache;
    readonly transport: string;
  };
  SummaryGenerated: { readonly model: string };
  ModelCall: {
    readonly operation: "generate" | "embed";
    // What the call was for, such as a summary or a query plan.
    readonly purpose: string;
    readonly provider: string;
    readonly model: string;
    readonly latencyMillis: number;
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
    readonly cacheReadTokens: number | undefined;
    readonly cacheWriteTokens: number | undefined;
    // What the provider billed, when it said.
    readonly costUsd: number | undefined;
    // The failure's tag, for a call that failed.
    readonly error: string | undefined;
    // The trace the call ran in, so PostHog groups a search's plan and embedding.
    readonly traceId: string | undefined;
  };
  Exception: {
    // Where it was caught: the message the failure was logged with.
    readonly source: string;
    readonly thrown: ReadonlyArray<Thrown>;
    readonly traceId: string | undefined;
  };
}>;
export const Event = Data.taggedEnum<Event>();

export interface Captured {
  readonly actor: Actor;
  readonly event: Event;
  readonly at: number;
}

// Where events go. Capturing only records the event, so it never waits on the network or fails.
export interface Sink {
  readonly capture: (captured: Captured) => void;
}

// Nothing is sent unless a layer provides a sink, so tests, local tools, and stages other than prod send nothing.
export const Analytics = Context.Reference<Sink>("@stargrep/analytics/analytics/Analytics", {
  defaultValue: () => ({ capture: () => undefined }),
});

export const CurrentActor = Context.Reference<Actor>("@stargrep/analytics/analytics/CurrentActor", {
  defaultValue: () => Actor.Stargrep(),
});

export const withActor =
  (actor: Actor) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, CurrentActor, actor);

// Untraced, because a span per event would only add noise to every traced call that captures one.
export const capture = Effect.fnUntraced(function* (event: Event) {
  const sink = yield* Analytics;
  const actor = yield* CurrentActor;
  const at = yield* Clock.currentTimeMillis;
  yield* Effect.sync(() => sink.capture({ actor, event, at }));
});

const maxValue = 1_000;
const maxStack = 8_000;

const thrownOf = (cause: Cause.Cause<unknown>): ReadonlyArray<Thrown> =>
  cause.reasons.some((reason) => reason._tag !== "Interrupt")
    ? Cause.prettyErrors(cause).map((error) => ({
        type: error.name,
        value: error.message.slice(0, maxValue),
        stack: error.stack?.slice(0, maxStack),
      }))
    : [];

const textOf = (parts: ReadonlyArray<unknown>) => parts.find(Predicate.isString) ?? "Error";

const fieldsOf = (parts: ReadonlyArray<unknown>): Readonly<Record<string, unknown>> =>
  Object.assign({}, ...parts.filter((part) => Predicate.isObject(part) && !Cause.isCause(part)));

const stringField = (fields: Readonly<Record<string, unknown>>, name: string) => {
  const value = fields[name];
  return Predicate.isString(value) ? value : undefined;
};

// A failure logged at error level is one no caller handled, so it becomes an exception event. The log's cause, or a
// cause logged as a field, gives each failure's type, message, and stack. A log without one names the failure it logged.
export const exceptionOf = (message: unknown, cause: Cause.Cause<unknown>): Event => {
  const parts: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message];
  const fields = fieldsOf(parts);
  const fieldCause = Cause.isCause(fields.cause) ? fields.cause : Cause.empty;
  const source = textOf(parts);
  const thrown = [...thrownOf(cause), ...thrownOf(fieldCause)];
  return Event.Exception({
    source,
    thrown:
      thrown.length > 0
        ? thrown
        : [
            {
              type: stringField(fields, "error") ?? stringField(fields, "failure") ?? "Error",
              value: source,
              stack: undefined,
            },
          ],
    traceId: stringField(fields, "traceId"),
  });
};

export const logger = Logger.make(({ logLevel, message, cause, fiber, date }) => {
  if (!LogLevel.isGreaterThanOrEqualTo(logLevel, "Error")) return;
  fiber.getRef(Analytics).capture({
    actor: fiber.getRef(CurrentActor),
    event: exceptionOf(message, cause),
    at: date.getTime(),
  });
});

export const layerLogger = Logger.layer([logger], { mergeWithExisting: true });

export const layerMemory = () => {
  const captured: Array<Captured> = [];
  const layer = Layer.succeed(Analytics, {
    capture: (entry) => {
      captured.push(entry);
    },
  });
  return { captured, layer };
};
