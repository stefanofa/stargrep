import * as Cloudflare from "@alchemy.run/cloudflare";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";

// The stargrep.com zone already exists in the account, so prod only references it and never creates or deletes it.
export const zone = "stargrep.com";

// Prod serves on one hostname. The main Worker holds the custom domain, which gives the hostname its DNS records and
// certificate, and a zone route sends every path to the web Worker. Routes take precedence over custom domains, so the
// custom domain stays on the main Worker and nothing detaches during a deploy. Until the route attaches, the custom
// domain sends every request to the main Worker, which answers /health itself.
export const prodWorkerHosting = {
  domain: { name: zone, zoneName: zone, redirects: [`www.${zone}`] },
  workersDev: false,
};

export const prodWebHosting = {
  routes: [{ pattern: `${zone}/*`, zoneName: zone }],
  workersDev: false,
};

// Pages, assets, and /icons are cached, so only the API and sign-in paths count. The Free plan allows one rate limiting
// rule that matches on the path without regular expressions, counts each IP per data center over 10 seconds, and blocks
// for 10 seconds. docs/architecture.md "Limits" says how the threshold was measured.
export const limitedPrefixes = ["/api", "/rpc", "/mcp", "/auth"] as const;

export const apiRequestsPer10Seconds = 150;

export const apiRateLimit = {
  ref: "stargrep_api_rate_limit",
  description: "Block one IP's flood of API and sign-in requests before it reaches a Worker",
  expression: limitedPrefixes
    .map((prefix) => `(http.request.uri.path eq "${prefix}" or http.request.uri.path wildcard "${prefix}/*")`)
    .join(" or "),
  action: "block",
  ratelimit: {
    characteristics: ["cf.colo.id", "ip.src"],
    period: 10,
    requestsPerPeriod: apiRequestsPer10Seconds,
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
