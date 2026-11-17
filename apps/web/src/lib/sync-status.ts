import type { EnrichmentProgress, SyncStatus } from "./rpc.ts";

// Repos the daily summary cap queued, and repos the summary policy holds back, are settled for now. Stargrep reads them on
// its own, possibly days later, so the page neither waits nor polls fast for them.
export const readingIncomplete = (enrichment: EnrichmentProgress) =>
  enrichment.read + enrichment.failed + enrichment.queued < enrichment.total;

export const firstImport = (status: SyncStatus) =>
  (status.state === "queued" || status.state === "waiting") && status.syncedAt === null;

// What a search of the login's stars was answered from: the stars its last sync wrote and how far reading them got. A
// completed sync or a newly read star changes it, so an answer from another revision describes another library.
export const libraryRevision = ({ syncedAt, enrichment }: SyncStatus) =>
  [syncedAt ?? "", enrichment.total, enrichment.read, enrichment.failed].join("/");

// A login whose sync status shows no stars synced yet has an empty library, so its first load asks for nothing. Its
// import reloads the library as stars land.
export const nothingSynced = (sync: SyncStatus | null) =>
  sync !== null && sync.syncedAt === null && sync.enrichment.total === 0;
