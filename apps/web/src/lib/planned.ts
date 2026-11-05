import type { Plate } from "@stargrep/ui";
import type { LibraryRepo, SyncStatus } from "./rpc.ts";

// Two backend pull requests add these fields and have not merged yet: repo icons adds `icon`, `ownerType` and
// `ownerAvatarUrl` to every repo, and enrichment state adds `read` to library repos and `enrichment` to the sync
// status. Until they land, a field the server leaves out reads as its absent value here, so the page renders today
// and lights up when they ship. Integrating them deletes this module.

export type OwnerType = "user" | "org";

export interface RepoIconFacts {
  readonly url: string;
  readonly plate: Plate;
}

export interface Enrichment {
  readonly total: number;
  readonly read: number;
  readonly failed: number;
}

export interface PlannedRepo {
  readonly icon?: RepoIconFacts | null;
  readonly ownerType?: OwnerType | null;
  readonly ownerAvatarUrl?: string | null;
  readonly read?: boolean;
}

export interface PlannedStatus {
  readonly enrichment?: Enrichment | null;
}

export interface RepoFacts {
  readonly icon: RepoIconFacts | null;
  readonly ownerType: OwnerType | null;
  readonly ownerAvatarUrl: string | null;
  readonly read: boolean;
}

export const repoFacts = (repo: LibraryRepo & PlannedRepo): RepoFacts => ({
  icon: repo.icon ?? null,
  ownerType: repo.ownerType ?? null,
  ownerAvatarUrl: repo.ownerAvatarUrl ?? null,
  read: repo.read ?? true,
});

export const enrichmentOf = (status: (SyncStatus & PlannedStatus) | undefined): Enrichment | null =>
  status?.enrichment ?? null;
