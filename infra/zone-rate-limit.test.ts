// @effect-diagnostics anyUnknownInErrorContext:off - Alchemy types a provider's lifecycle effects with any.
// @effect-diagnostics unsafeEffectTypeAssertion:off - the provider and its credentials are all provided below.
import { describe, expect, test } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Credentials } from "@alchemy.run/cloudflare/Credentials";
import { apiRateLimitRuleset, zone } from "@stargrep/worker/domain";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const zoneId = "250762ec9899f1d5fab4738a5294a5f2";

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const sentByProdDeploy = async () => {
  const sent: Array<Sent> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined;
      sent.push({ method: request.method, url: request.url, body });
      const result = {
        ...body,
        id: "ruleset-id",
        kind: "zone",
        phase: "http_ratelimit",
        version: "1",
        last_updated: "2026-11-06T00:00:00Z",
      };
      return HttpClientResponse.fromWeb(request, Response.json({ success: true, errors: [], messages: [], result }));
    }),
  );
  const credentials = Layer.succeed(
    Credentials,
    Effect.succeed({
      type: "apiToken",
      apiToken: Redacted.make("test"),
      apiBaseUrl: "https://api.cloudflare.com/client/v4",
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Provider<Cloudflare.Ruleset.Ruleset>("Cloudflare.Ruleset.Ruleset");
      return yield* provider.reconcile({
        id: "ApiRateLimit",
        news: { zone: { zoneId, name: zone } as never, ...apiRateLimitRuleset },
        output: undefined,
      } as never);
    }).pipe(
      Effect.provide(
        Cloudflare.Ruleset.RulesetProvider().pipe(
          Layer.provideMerge(Layer.merge(credentials, Layer.succeed(HttpClient.HttpClient, client))),
        ),
      ),
    ) as Effect.Effect<unknown>,
  );
  return sent;
};

describe("zone rate limit", () => {
  test("prod's deploy replaces the zone's http_ratelimit entrypoint with one Free plan rule", async () => {
    expect(await sentByProdDeploy()).toEqual([
      {
        method: "PUT",
        url: `https://api.cloudflare.com/client/v4/zones/${zoneId}/rulesets/phases/http_ratelimit/entrypoint`,
        body: {
          name: "stargrep-api-rate-limit",
          rules: [
            {
              ref: "stargrep_api_rate_limit",
              description: "Block one IP's flood of API and sign-in requests before it reaches a Worker",
              expression:
                '(http.request.uri.path eq "/api" or http.request.uri.path wildcard "/api/*") or ' +
                '(http.request.uri.path eq "/rpc" or http.request.uri.path wildcard "/rpc/*") or ' +
                '(http.request.uri.path eq "/mcp" or http.request.uri.path wildcard "/mcp/*") or ' +
                '(http.request.uri.path eq "/auth" or http.request.uri.path wildcard "/auth/*")',
              action: "block",
              ratelimit: {
                characteristics: ["cf.colo.id", "ip.src"],
                period: 10,
                requests_per_period: 150,
                mitigation_timeout: 10,
              },
            },
          ],
        },
      },
    ]);
  });
});
