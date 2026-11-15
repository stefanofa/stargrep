import { isPreviewStage } from "@stargrep/runtime/stage";
import * as Regex from "effect/RegExp";

// The stargrep.com zone already exists in the account, so no stage creates or deletes it.
export const zone = "stargrep.com";

// Prod serves on one hostname. The main Worker holds the custom domain, which gives the hostname its DNS records and
// certificate, and a zone route sends every path to the web Worker. Routes take precedence over custom domains, so the
// custom domain stays on the main Worker and nothing detaches during a deploy. Until the route attaches, the custom
// domain sends every request to the main Worker, which answers /health itself.
const prod = {
  worker: { domain: { name: zone, zoneName: zone, redirects: [`www.${zone}`] }, workersDev: false },
  web: { routes: [{ pattern: `${zone}/*`, zoneName: zone }], workersDev: false },
  debug: {},
};

// A preview's web and debug Workers serve on custom domains one level under the zone, because the zone's Universal
// certificate covers only one level. A Worker's destroy detaches its own custom domains and their DNS records. The main
// Worker answers only through the web Worker's service binding, so it has no URL.
const preview = (stage: string) => ({
  worker: { workersDev: false },
  web: { domain: { name: `${stage}.${zone}`, zoneName: zone }, workersDev: false },
  debug: { domain: { name: `${stage}-debug.${zone}`, zoneName: zone }, workersDev: false },
});

// A local stage runs under alchemy dev, which serves each Worker on localhost.
const local = { worker: {}, web: {}, debug: {} };

export const stageHosting = (stage: string) =>
  stage === "prod" ? prod : isPreviewStage(stage) ? preview(stage) : local;

// Prod's sign-in sends a preview back only to a preview's web hostname.
export const previewHost = new globalThis.RegExp(`^pr-\\d+\\.${Regex.escape(zone)}$`);
