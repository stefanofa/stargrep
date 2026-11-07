import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decodeErrors } from "./graphql.ts";
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

export type Classification =
  | { readonly _tag: "Ok" }
  | { readonly _tag: "Unauthorized" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "RateLimited"; readonly retryAfterMillis: number; readonly windowSpent: boolean }
  | { readonly _tag: "Failed" };

export const classify = (reply: Reply, now: number): Classification => {
  if (reply.status === 401) return { _tag: "Unauthorized" };
  if (reply.status === 404) return { _tag: "NotFound" };
  const graphql =
    isSuccess(reply.status) &&
    Option.exists(Option.flatMap(reply.body, decodeErrors), (body) =>
      (body.errors ?? []).some((error) => error.type === "RATE_LIMITED"),
    );
  const limited =
    graphql ||
    reply.status === 429 ||
    (reply.status === 403 &&
      (Option.isSome(waitOf(reply, now)) || Option.exists(reply.body, (body) => secondaryLimit.test(body))));
  if (limited)
    return {
      _tag: "RateLimited",
      retryAfterMillis: Option.getOrElse(waitOf(reply, now), () => defaultWait),
      windowSpent: Option.contains(reply.rateLimit.remaining, 0),
    };
  return { _tag: isSuccess(reply.status) ? "Ok" : "Failed" };
};
