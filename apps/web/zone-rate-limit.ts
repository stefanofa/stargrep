import * as Cloudflare from "@alchemy.run/cloudflare";
import { zone } from "@stargrep/worker/domain";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { apiPrefixes } from "./src/server/api-prefixes.ts";

// The rule counts the paths a script calls, the API and sign-in. Assets are served before any Worker runs, and /icons
// answers from the Workers cache or R2. A page renders in the Worker on every request, but it calls the API in process,
// where the Workers rate limit bindings still count the searches and star pages it asks for. The Free plan allows one
// rate limiting rule that matches on the path without regular expressions, counts each IP per data center over 10
// seconds, and blocks for 10 seconds. docs/architecture.md "Limits" says how the threshold was measured.
const apiRateLimit = {
  ref: "stargrep_api_rate_limit",
  description: "Block one IP's flood of API and sign-in requests before it reaches a Worker",
  expression: Object.values(apiPrefixes)
    .map((prefix) => `(http.request.uri.path eq "${prefix}" or http.request.uri.path wildcard "${prefix}/*")`)
    .join(" or "),
  action: "block",
  ratelimit: {
    characteristics: ["cf.colo.id", "ip.src"],
    period: 10,
    requestsPerPeriod: 150,
    mitigationTimeout: 10,
  },
} satisfies Cloudflare.Ruleset.Rule;

export const apiRateLimitRuleset: Omit<Cloudflare.Ruleset.RulesetProps, "zone"> = {
  name: "stargrep-api-rate-limit",
  phase: "http_ratelimit",
  rules: [apiRateLimit],
};

// The zone resource only adopts the zone so the ruleset can name it. Zones default to retain, so a destroy leaves it.
export const ZoneRateLimit = Effect.gen(function* () {
  const zoneResource = yield* Cloudflare.Zone.Zone("Zone", { name: zone }).pipe(adopt(true));
  return yield* Cloudflare.Ruleset.Ruleset("ApiRateLimit", { zone: zoneResource, ...apiRateLimitRuleset });
});
