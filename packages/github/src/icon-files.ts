import type { TreeEntry } from "./readme.ts";
import type { RepoFile } from "./schemas.ts";

const iconName =
  /^(logo|icon|favicon|mark|brand)((?:[-_.]?(?:light|dark|white|black|square|mark|\d+))*)\.(svg|png|webp|ico)$/i;
const baseRank: Record<string, number> = { logo: 0, icon: 0, mark: 2, brand: 2, favicon: 3 };
const extensionRank = ["svg", "png", "webp", "ico"];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const rankOf = (name: string, repoName: RegExp) => {
  const named = repoName.exec(name);
  if (named !== null) return [1, extensionRank.indexOf(named[1]?.toLowerCase() ?? ""), 0];
  const match = iconName.exec(name);
  if (match === null) return null;
  const [, base = "", variants = "", extension = ""] = match;
  return [baseRank[base.toLowerCase()] ?? 3, extensionRank.indexOf(extension.toLowerCase()), variants.length];
};

const compare = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) =>
  a.reduce((order, value, index) => order || value - (b[index] ?? 0), 0);

export const rankIconFiles = (entries: ReadonlyArray<TreeEntry>, repo: string): ReadonlyArray<RepoFile> => {
  const repoName = new RegExp(`^${escapeRegExp(repo)}\\.(svg|png|webp)$`, "i");
  return entries
    .flatMap((entry) => {
      const rank = entry.type === "blob" ? rankOf(entry.name, repoName) : null;
      return rank === null ? [] : [{ file: { name: entry.name, oid: entry.oid }, rank }];
    })
    .toSorted((a, b) => compare(a.rank, b.rank) || a.file.name.localeCompare(b.file.name))
    .map(({ file }) => file);
};
