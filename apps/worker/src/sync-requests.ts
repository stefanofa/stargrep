import * as Cloudflare from "@alchemy.run/cloudflare";

export const SyncRequests = Cloudflare.KV.Namespace("SyncRequests");
