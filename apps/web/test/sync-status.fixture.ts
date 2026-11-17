import { SyncStatus } from "@stargrep/api/contract";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(SyncStatus);
const time = "2026-11-05T10:00:00.000Z";

export const syncStatus = (extra: Partial<typeof SyncStatus.Type>): typeof SyncStatus.Type => {
  const state = extra.state ?? "done";
  const never = state === "unknown" || state === "missing";
  return decode({
    login: "junodev",
    state,
    requestedAt: state === "done" || never ? null : time,
    syncedAt: never ? null : time,
    waiting: null,
    starredTotal: null,
    accountType: null,
    enrichment: { total: 1776, read: 1776, failed: 0, queued: 0 },
    ...extra,
  });
};
