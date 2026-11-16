import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { stargrepRepo } from "../lib/github-star.ts";

const Count = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const decodeReply = Schema.decodeUnknownOption(Schema.Struct({ stargazers_count: Count }));
const decodeKept = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.NullOr(Count)));

// The cache keeps a count for an hour, so a location asks GitHub at most once an hour however busy it gets. A failed
// read keeps "no count" for 10 minutes, so an unreachable GitHub is not asked on every page.
const keep = { count: Duration.hours(1), failure: Duration.minutes(10) };

export interface StarStore {
  readonly cache: () => Promise<Cache>;
  readonly waitUntil: (work: Promise<unknown>) => void;
  // How long a render waits for GitHub on a miss. The read goes on after that and fills the cache for the next page.
  readonly renderWait: Duration.Input;
}

// Every visitor sees the same number, so the read carries no token and spends no one's GitHub budget.
const readGitHub = HttpClient.get(`https://api.github.com/repos/${stargrepRepo}`, {
  headers: { accept: "application/vnd.github+json", "user-agent": "stargrep", "x-github-api-version": "2022-11-28" },
}).pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap((response) => response.json),
  Effect.map((body) => Option.getOrNull(Option.map(decodeReply(body), (reply) => reply.stargazers_count))),
  Effect.timeout(Duration.seconds(10)),
  Effect.orElseSucceed(() => null),
);

// The header's count of Stargrep's own GitHub stars, kept in the location's cache. A count the cache lacks, a GitHub
// that fails, or a cache that throws renders the header without a count, and never fails or holds up the page.
export const repoStars = Effect.fn("repoStars")(function* (
  origin: string,
  { cache, waitUntil, renderWait }: StarStore,
) {
  const key = `${origin}/_cache/github-stars/${stargrepRepo}`;
  const kept = yield* Effect.tryPromise(async () => {
    const response = await (await cache()).match(key);
    return response === undefined ? Option.none() : decodeKept(await response.text());
  }).pipe(Effect.orElseSucceed(() => Option.none<number | null>()));
  if (Option.isSome(kept)) return kept.value;
  const fill = readGitHub.pipe(
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
