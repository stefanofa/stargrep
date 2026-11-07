import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { normalize } from "./keyword.ts";

export const pause = Duration.millis(250);

export const minimumLength = 3;

export interface Answer<A, E> {
  readonly query: string;
  readonly result: Result.Result<A, E> | undefined;
}

export interface Ask {
  readonly query: string;
  readonly round: number;
}

const same = (a: Ask, b: Ask) => a.query === b.query && a.round === b.round;

// Each query is asked once, until it changes or a refresh asks again. A query the page already has an answer for, such
// as the one the server painted, counts as asked.
export const semanticAnswers = <A, E, R>(
  asks: Stream.Stream<Ask>,
  search: (query: string) => Effect.Effect<A, E, R>,
  answered?: string,
): Stream.Stream<Answer<A, E>, never, R> =>
  asks.pipe(
    Stream.map(({ query, round }) => ({ query: normalize(query), round })),
    Stream.debounce(pause),
    Stream.mapAccum(
      (): Ask | undefined => (answered === undefined ? undefined : { query: normalize(answered), round: 0 }),
      (previous, ask) => [ask, previous !== undefined && same(previous, ask) ? [] : [ask]] as const,
    ),
    Stream.switchMap(({ query }) =>
      query.length < minimumLength
        ? Stream.succeed<Answer<A, E>>({ query, result: undefined })
        : Stream.fromEffect(Effect.map(Effect.result(search(query)), (result) => ({ query, result }))),
    ),
  );

export class SearchFailed extends Data.TaggedError("SearchFailed")<{ readonly cause: unknown }> {}

export const startSemanticSearch = <A>(
  search: (query: string, signal: AbortSignal) => Promise<A>,
  onAnswer: (answer: Answer<A, SearchFailed>) => void,
  answered?: string,
) => {
  const asks = Effect.runSync(Queue.unbounded<Ask>());
  let last: Ask = { query: answered ?? "", round: 0 };
  const ask = (next: Ask) => {
    last = next;
    Queue.offerUnsafe(asks, next);
  };
  const fiber = Effect.runFork(
    semanticAnswers(
      Stream.fromQueue(asks),
      (query) =>
        Effect.tryPromise({ try: (signal) => search(query, signal), catch: (cause) => new SearchFailed({ cause }) }),
      answered,
    ).pipe(Stream.runForEach((answer) => Effect.sync(() => onAnswer(answer)))),
  );
  return {
    offer: (query: string) => ask({ ...last, query }),
    refresh: () => ask({ ...last, round: last.round + 1 }),
    stop: () => Effect.runFork(Fiber.interrupt(fiber)),
  };
};
