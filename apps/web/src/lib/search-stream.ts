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

export const semanticAnswers = <A, E, R>(
  queries: Stream.Stream<string>,
  search: (query: string) => Effect.Effect<A, E, R>,
): Stream.Stream<Answer<A, E>, never, R> =>
  queries.pipe(
    Stream.map(normalize),
    Stream.debounce(pause),
    Stream.changes,
    Stream.switchMap((query) =>
      query.length < minimumLength
        ? Stream.succeed<Answer<A, E>>({ query, result: undefined })
        : Stream.fromEffect(Effect.map(Effect.result(search(query)), (result) => ({ query, result }))),
    ),
  );

export class SearchFailed extends Data.TaggedError("SearchFailed")<{ readonly cause: unknown }> {}

export const startSemanticSearch = <A>(
  search: (query: string, signal: AbortSignal) => Promise<A>,
  onAnswer: (answer: Answer<A, SearchFailed>) => void,
) => {
  const queries = Effect.runSync(Queue.unbounded<string>());
  const fiber = Effect.runFork(
    semanticAnswers(Stream.fromQueue(queries), (query) =>
      Effect.tryPromise({ try: (signal) => search(query, signal), catch: (cause) => new SearchFailed({ cause }) }),
    ).pipe(Stream.runForEach((answer) => Effect.sync(() => onAnswer(answer)))),
  );
  return {
    offer: (query: string) => Queue.offerUnsafe(queries, query),
    stop: () => Effect.runFork(Fiber.interrupt(fiber)),
  };
};
