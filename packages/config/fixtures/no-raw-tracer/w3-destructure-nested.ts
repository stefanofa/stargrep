import * as Cloudflare from "@alchemy.run/cloudflare";
const { Workers } = Cloudflare;
const { Telemetry } = Workers;
export const x = Telemetry({});
