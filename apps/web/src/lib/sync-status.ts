import type { EnrichmentProgress, SyncStatus } from "./rpc.ts";

export const readingIncomplete = (enrichment: EnrichmentProgress) =>
  enrichment.read + enrichment.failed < enrichment.total;

export const firstImport = (status: SyncStatus) =>
  (status.state === "queued" || status.state === "waiting") && status.syncedAt === null;

// A login whose sync status shows no stars synced yet has an empty library, so its first load asks for nothing. Its
// import reloads the library as stars land.
export const nothingSynced = (sync: SyncStatus | null) =>
  sync !== null && sync.syncedAt === null && sync.enrichment.total === 0;
