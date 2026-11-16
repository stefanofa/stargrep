import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { stargrepRepo } from "../lib/github-star.ts";

const Count = Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))));
const decodeReply = Schema.decodeUnknownOption(Count);
const decodeKept = Schema.decodeUnknownOption(Schema.fromJsonString(Count));

// The cache keeps a count for an hour, so a location asks GitHub at most once an hour however busy it gets. A failed
// read keeps "no count" for 10 minutes, so an unreachable GitHub is not asked on every page.
const keep = { count: Duration.hours(1), failure: Duration.minutes(10) };

// The main Worker reads the count with the server's GitHub token, so the web Worker holds no token and never asks
// GitHub itself. Its answer is a count or null, and never an error.
export interface StarsWorker {
  readonly stargrepStars: () => Promise<unknown>;
}

export interface StarStore {
  readonly worker: StarsWorker;
  readonly cache: () => Promise<Cache>;
  readonly waitUntil: (work: Promise<unknown>) => void;
  // How long a render waits for GitHub on a miss. The read goes on after that and fills the cache for the next page.
  readonly renderWait: Duration.Input;
}

const readThroughWorker = (worker: StarsWorker) =>
  Effect.tryPromise(() => worker.stargrepStars()).pipe(
    Effect.map((reply) => Option.getOrNull(decodeReply(reply))),
    Effect.timeout(Duration.seconds(10)),
    Effect.orElseSucceed(() => null),
  );

// The header's count of Stargrep's own GitHub stars, kept in the location's cache. A count the cache lacks, a GitHub
// that fails, or a cache that throws renders the header without a count, and never fails or holds up the page.
export const repoStars = Effect.fn("repoStars")(function* (
  origin: string,
  { worker, cache, waitUntil, renderWait }: StarStore,
) {
  const key = `${origin}/_cache/github-stars/${stargrepRepo}`;
  const kept = yield* Effect.tryPromise(async () => {
    const response = await (await cache()).match(key);
    return response === undefined ? Option.none() : decodeKept(await response.text());
  }).pipe(Effect.orElseSucceed(() => Option.none<number | null>()));
  if (Option.isSome(kept)) return kept.value;
  const fill = readThroughWorker(worker).pipe(
    Effect.tap((count) =>
      Effect.tryPromise(async () => {
        const seconds = Duration.toSeconds(count === null ? keep.failure : keep.count);
        const body = new Response(String(count), { headers: { "cache-control": `s-maxage=${seconds}` } });
        await (await cache()).put(key, body);
      }).pipe(Effect.ignore),
    ),
  );
  const filled = Promise.withResolvers<void>();
  waitUntil(filled.promise);
  const reading = yield* Effect.forkDetach(fill.pipe(Effect.ensuring(Effect.sync(filled.resolve))));
  return Option.getOrNull(yield* Fiber.join(reading).pipe(Effect.timeoutOption(renderWait)));
});
