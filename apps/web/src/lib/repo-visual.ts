import type { RepoVisual } from "@stargrep/ui";
import type { LibraryRepo, OwnerType } from "./rpc.ts";

export const avatarOwners: ReadonlySet<OwnerType> = new Set(["org", "user"]);

const avatarSize = 88;

const sized = (url: string) => {
  const parsed = new URL(url);
  if (parsed.hostname !== "avatars.githubusercontent.com") return url;
  parsed.searchParams.set("s", String(avatarSize));
  return parsed.toString();
};

export const repoVisual = (
  repo: Pick<LibraryRepo, "owner" | "icon" | "ownerType" | "ownerAvatarUrl">,
  owners: ReadonlySet<OwnerType> = avatarOwners,
): RepoVisual => {
  const letters = repo.owner.slice(0, 2).toLowerCase();
  if (repo.icon !== null) return { kind: "icon", ...repo.icon, letters };
  if (repo.ownerAvatarUrl !== null && repo.ownerType !== null && owners.has(repo.ownerType))
    return { kind: "avatar", url: sized(repo.ownerAvatarUrl), letters };
  return { kind: "monogram", letters };
};
