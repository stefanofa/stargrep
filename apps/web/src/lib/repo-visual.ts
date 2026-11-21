import type { RepoIconSize, RepoVisual } from "@stargrep/ui";
import type { LibraryRepo, OwnerType } from "./rpc.ts";

export const avatarOwners: ReadonlySet<OwnerType> = new Set(["org", "user"]);

// Twice each slot's side, so an avatar stays sharp on a 2x screen.
const avatarSizes: Record<RepoIconSize, number> = { card: 88, row: 72, panel: 112 };

const sized = (url: string, slot: RepoIconSize) => {
  const parsed = new URL(url);
  if (parsed.hostname !== "avatars.githubusercontent.com") return url;
  parsed.searchParams.set("s", String(avatarSizes[slot]));
  return parsed.toString();
};

export const repoVisual = (
  repo: Pick<LibraryRepo, "owner" | "icon" | "ownerType" | "ownerAvatarUrl">,
  slot: RepoIconSize,
  owners: ReadonlySet<OwnerType> = avatarOwners,
): RepoVisual => {
  const letters = repo.owner.slice(0, 2).toLowerCase();
  if (repo.icon !== null) return { kind: "icon", ...repo.icon, letters };
  if (repo.ownerAvatarUrl !== null && repo.ownerType !== null && owners.has(repo.ownerType))
    return { kind: "avatar", url: sized(repo.ownerAvatarUrl, slot), letters };
  return { kind: "monogram", letters };
};
