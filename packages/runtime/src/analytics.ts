import * as Analytics from "@stargrep/analytics/analytics";
import * as PostHog from "@stargrep/analytics/posthog";
import * as Config from "effect/Config";
import * as Digest from "effect/crypto/Digest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { stageSettings } from "./stage.ts";

export const stageName = "STARGREP_STAGE";

// A Worker deployed without the binding, such as one in a workerd test, counts as no stage and sends nothing.
export const stage = Config.String(stageName).pipe(Config.withDefault(""));

// Only prod sends product events, model usage, and error logs to PostHog. Every other stage keeps the default sink,
// which drops them, so previews, local stages, and tests send nothing.
export const sends = (stage: string) => stageSettings(stage).production;

export const layer = <R>(stage: string, background: PostHog.Options<R>["background"]): Layer.Layer<never, never, R> =>
  sends(stage)
    ? Layer.merge(PostHog.layer({ stage, background }), Analytics.layerLogger).pipe(
        Layer.provide([FetchHttpClient.layer, Digest.layerWebCrypto]),
      )
    : Layer.empty;
