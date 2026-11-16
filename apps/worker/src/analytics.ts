import * as Cloudflare from "@alchemy.run/cloudflare";
import * as AnalyticsLayer from "@stargrep/runtime/analytics";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export type Observe = (
  source: string,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | RuntimeContext>;

// Analytics for one queue batch or one cron run: a sink that sends after the handler returns, and error logs as
// exceptions. A failure no step caught is logged too, so it reaches PostHog before the queue retries the batch.
export const observe =
  (stage: string): Observe =>
  (source) =>
  (effect) =>
    effect.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(`${source} failed`, cause),
      ),
      Effect.provide(AnalyticsLayer.layer(stage, Cloudflare.waitUntil)),
    );
