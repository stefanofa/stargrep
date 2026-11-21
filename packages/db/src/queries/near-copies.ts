// Forks and mirrors of a popular repo sit among its nearest neighbors, so the similar rows leave out a repo that copies
// the opened one or another neighbor. A copy is named like its original, has far fewer stars, and sits near it. Its
// summary differs enough that distance alone doesn't tell it apart: on a branch of prod, forks named like the original
// sat 0.03 to 0.14 from it, while distinct lists such as emijrp/awesome-awesome sat 0.08 from sindresorhus/awesome.

export interface Neighbor {
  readonly repo: { readonly id: number; readonly owner: string; readonly name: string };
  readonly stars: number | null;
  // Cosine distance from the opened repo, 0 for the opened repo itself.
  readonly distance: number;
}

// How many more stars the original has than a copy, at least. Ports and companions named after a popular repo, such
// as llama-cpp-python or rustdesk-server, have a tenth of its stars or more.
const starRatio = 10;
// How near a repo named like another sits to it to count as its copy. On the branch, forks sat up to 0.14 from their
// original, and distinct repos that share a plain name, such as curriculum, notes, and most dotfiles, 0.12 or more.
const namedCopyDistance = 0.15;
// The same for a name of fewer than 8 letters. Distinct repos named cli, log, or imgui sat 0.13 to 0.15 apart.
const shortNamedCopyDistance = 0.1;
// A repo this near the opened one counts as its copy whatever its name. Among the neighbors of the 300 most starred
// repos on the branch, only forks sat nearer with a tenth of the stars.
const closeCopyDistance = 0.05;

// Lowercase letters and digits only, so build-your-own-x and Build_Your_Own_X compare equal.
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== ""),
  );

// A suffix that marks a translation, such as system-design-primer-zh-tw.
const locales = new Set(["zhcn", "zhtw", "zhhk", "zhhans", "zhhant", "chn", "ptbr", "jpn", "kor", "rus"]);
// A short suffix that marks a port or a companion, such as tesseract-rs, rather than a copy.
const companions = new Set(
  "r c rs go py js ts rb kt cs ex jl hs ml ui cpp php lua vim cli api sdk web app gui tui bot mcp net lib ios".split(
    " ",
  ),
);
// What a mirror's name adds around the original's, as in https-github.com-practical-tutorials-project-based-learning.
const mirrorWords = ["https", "http", "github", "com", "master", "fork", "mirror"];

// What the longer of two names adds to the shorter, and how many letters of it a copy may add, when the longer holds
// the shorter whole or holds its 3 or more words. Undefined when it does neither. A concept's name takes a few letters
// more often than a fork's does, as Graph-COM/SubgraphRAG does microsoft/graphrag's.
const added = (a: string, b: string): { readonly extra: string; readonly most: number } | undefined => {
  const [short, long] = squash(a).length <= squash(b).length ? [a, b] : [b, a];
  if (squash(short).length >= 6 && squash(long).includes(squash(short))) {
    return { extra: squash(long).replace(squash(short), ""), most: 2 };
  }
  // Words left out, as in Teslow/build-your-x against build-your-own-x.
  const shortWords = words(short);
  const longWords = words(long);
  if (shortWords.size < 3 || shortWords.size >= longWords.size) return undefined;
  if (![...shortWords].every((word) => longWords.has(word))) return undefined;
  return { extra: [...longWords].filter((word) => !shortWords.has(word)).join(""), most: 3 };
};

// One repo's name copies the other's: the same, or with an owner, a locale, or a few letters added.
const namedAlike = (a: Neighbor["repo"], b: Neighbor["repo"]): boolean => {
  // An owner can't fork its own repo, so two repos of one owner are siblings, as microsoft/playwright-java is.
  if (squash(a.owner) === squash(b.owner)) return false;
  if (squash(a.name) === squash(b.name)) return true;
  const difference = added(a.name, b.name);
  if (difference === undefined) return false;
  const rest = [squash(a.owner), squash(b.owner), ...mirrorWords]
    .filter((word) => word.length >= 3)
    .reduce((left, word) => left.replace(word, ""), difference.extra);
  return rest === "" || locales.has(rest) || (rest.length <= difference.most && !companions.has(rest));
};

// How near one repo sits to the other, at most, to count as its copy by name, or 0 when the names don't match.
export const copyDistance = (a: Neighbor["repo"], b: Neighbor["repo"]): number => {
  if (!namedAlike(a, b)) return 0;
  return Math.min(squash(a.name).length, squash(b.name).length) >= 8 ? namedCopyDistance : shortNamedCopyDistance;
};

const farFewerStars = (copy: Neighbor, original: Neighbor) =>
  copy.stars !== null && original.stars !== null && original.stars >= starRatio * Math.max(copy.stars, 1);

export interface Suspect {
  readonly copy: number;
  readonly original: number;
  // How near the copy sits to the original, at most, to count as its copy.
  readonly within: number;
}

// The pairs of a repo found and another repo found or referenced that it may copy, by name and stars. Only how far apart
// they sit is left to tell. References are repos that never show, such as the account's own stars beside the repos it
// doesn't star, which can be the original of a fork found.
export const suspects = (found: ReadonlyArray<Neighbor>, references: ReadonlyArray<Neighbor>): ReadonlyArray<Suspect> =>
  found.flatMap((copy) =>
    [...found, ...references]
      .filter((original) => original.repo.id !== copy.repo.id)
      .filter((original) => farFewerStars(copy, original))
      .map((original) => ({
        copy: copy.repo.id,
        original: original.repo.id,
        within: copyDistance(copy.repo, original.repo),
      }))
      .filter((suspect) => suspect.within > 0),
  );

const copiesOpened = (found: Neighbor, opened: Neighbor) =>
  farFewerStars(found, opened) && found.distance < Math.max(closeCopyDistance, copyDistance(found.repo, opened.repo));

// The nearest `limit` repos found, in order, leaving out a copy of the opened repo and a suspect that sits near its
// original. `apart` holds each suspect's distance from its original.
export const withoutCopies = <A extends Neighbor>(
  opened: Neighbor,
  found: ReadonlyArray<A>,
  apart: ReadonlyArray<Suspect & { readonly distance: number }>,
  limit: number,
): ReadonlyArray<A> => {
  const copies = new Set(apart.filter((pair) => pair.distance < pair.within).map((pair) => pair.copy));
  return found.filter((repo) => !copies.has(repo.repo.id) && !copiesOpened(repo, opened)).slice(0, limit);
};
