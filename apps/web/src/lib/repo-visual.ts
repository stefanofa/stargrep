import type { RepoVisual } from "@stargrep/ui";
import type { LibraryRepo, OwnerType } from "./rpc.ts";

// Owners whose GitHub avatar stands in for a repo with no icon of its own. An org's avatar is usually the project's
// logo; a person's is a face, so their repos get a monogram. Adding "user" here switches people to their avatar.
export const avatarOwners: ReadonlySet<OwnerType> = new Set(["org"]);

const avatarSize = 88;

const sized = (url: string) => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "avatars.githubusercontent.com") return url;
    parsed.searchParams.set("s", String(avatarSize));
    return parsed.toString();
  } catch {
    return url;
  }
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
