import * as Cloudflare from "@alchemy.run/cloudflare";
export const f = ({ Telemetry }: typeof Cloudflare) => Telemetry({});
let g: unknown;
({ Telemetry: g } = Cloudflare);
export { g };
