import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { IntFromString } from "./schemas.ts";
import { isSuccess, type Reply } from "./token-gate.ts";

const decodeSeconds = Schema.decodeUnknownOption(IntFromString);

// GitHub asks for a one minute wait on a rate limit that names no time.
const defaultWait = 60_000;

// GitHub's guidance on when to try again: retry-after, else the window's reset once nothing remains in it.
const waitOf = (reply: Reply, now: number): Option.Option<number> =>
  Option.orElse(
    Option.map(decodeSeconds(reply.headers["retry-after"]), (seconds) => seconds * 1000),
    () =>
      reply.rateLimit.remaining.pipe(
        Option.filter((remaining) => remaining === 0),
        Option.flatMap(() => reply.rateLimit.resetAt),
        Option.map((resetAt) => Math.max(0, resetAt - now)),
      ),
  );

// GitHub sends a secondary rate limit as a 403 that can keep quota and name no wait, so only its message names it.
const secondaryLimit = /secondary rate limit|abuse detection/i;

export const isRateLimit = (reply: Reply, now: number) =>
  reply.status === 429 ||
  (reply.status === 403 &&
    (Option.isSome(waitOf(reply, now)) || Option.exists(reply.body, (body) => secondaryLimit.test(body))));

export const retryAfterMillis = (reply: Reply, now: number) => Option.getOrElse(waitOf(reply, now), () => defaultWait);

const GraphQLErrors = Schema.fromJsonString(
  Schema.Struct({
    errors: Schema.optionalKey(Schema.Array(Schema.Struct({ type: Schema.optionalKey(Schema.String) }))),
  }),
);
const decodeGraphQLErrors = Schema.decodeUnknownOption(GraphQLErrors);

// GraphQL answers a spent window with a 200 whose errors name RATE_LIMITED.
const isGraphQLRateLimit = (reply: Reply) =>
  isSuccess(reply.status) &&
  Option.exists(Option.flatMap(reply.body, decodeGraphQLErrors), (body) =>
    (body.errors ?? []).some((error) => error.type === "RATE_LIMITED"),
  );

// A rate limit with nothing remaining: whoever owns the token spent the window.
export const isWindowSpent = (reply: Reply, now: number) =>
  Option.contains(reply.rateLimit.remaining, 0) && (isRateLimit(reply, now) || isGraphQLRateLimit(reply));
