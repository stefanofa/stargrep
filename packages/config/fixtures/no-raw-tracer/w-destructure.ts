import * as Cloudflare from "@alchemy.run/cloudflare";
const { Telemetry } = Cloudflare;
export const tracer = Telemetry.layer();
