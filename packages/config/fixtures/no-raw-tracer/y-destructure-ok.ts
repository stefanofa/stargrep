import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Otlp from "@stargrep/telemetry/otlp";
export const { Workers } = Cloudflare;
export const { layer } = Otlp;
