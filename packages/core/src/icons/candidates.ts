import type { ObjectId, RepoFile } from "@stargrep/github/schemas";
import { templateBlobs } from "./templates.ts";

export type IconCandidate =
  | { readonly source: "repo-file"; readonly url: string; readonly oid: ObjectId }
  | { readonly source: "readme-image"; readonly url: string }
  | { readonly source: "homepage"; readonly url: string };

export interface CandidateInput {
  readonly owner: string;
  readonly name: string;
  readonly homepage: string | null;
  readonly iconFiles: ReadonlyArray<RepoFile>;
  readonly readme: string | null;
}

const maxRepoFiles = 2;
const readmeScanChars = 20_000;
const imagePattern =
  /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
const badgeHosts =
  /(^|\.)(shields\.io|badgen\.net|badge\.fury\.io|star-history\.com|contrib\.rocks|codecov\.io|codacy\.com|deepwiki\.com|pepy\.tech|vercel\.com|netlify\.com)$/i;
const badgePath = /badge|\/workflows\//i;
const unusableExtension = /\.(gif|mp4|webm|mov)$/i;
const skippedHomepages =
  /(^|\.)(github\.com|npmjs\.(com|org)|pypi\.(org|python\.org)|crates\.io|docs\.rs|pkg\.go\.dev|marketplace\.visualstudio\.com|patreon\.com|opencollective\.com|ko-fi\.com|buymeacoffee\.com|twitter\.com|x\.com|youtube\.com|linkedin\.com)$/i;

export const ownSite = (url: string) => {
  const parsed = URL.parse(url);
  return parsed !== null && /^https?:$/.test(parsed.protocol) && !skippedHomepages.test(parsed.hostname);
};

const decoded = (text: string) =>
  text.replace(/(?:%[0-9a-f]{2})+/gi, (escapes) => {
    try {
      return decodeURIComponent(escapes);
    } catch {
      return escapes;
    }
  });

const raw = (owner: string, name: string, ref: string, path: string) =>
  `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${path.split("/").map(encodeURIComponent).join("/")}`;

const sameRepo = (owner: string, name: string, otherOwner = "", otherName = "") =>
  otherOwner.toLowerCase() === owner.toLowerCase() && otherName.toLowerCase() === name.toLowerCase();

const inRepoUrl = (owner: string, name: string, src: string): string | null => {
  if (src.startsWith("#") || src.startsWith("data:")) return null;
  const absolute = URL.parse(src);
  if (absolute === null) {
    if (src.startsWith("//")) return null;
    const path = decoded(src.split(/[?#]/)[0] ?? "").replace(/^(\.\/|\/)+/, "");
    return path === "" || path.startsWith("../") ? null : raw(owner, name, "HEAD", path);
  }
  if (badgeHosts.test(absolute.hostname) || badgePath.test(absolute.pathname)) return null;
  const [, first, second, kind, ref, ...rest] = absolute.pathname.split("/").map(decoded);
  if (absolute.hostname === "raw.githubusercontent.com") {
    return sameRepo(owner, name, first, second) && kind !== undefined && ref !== undefined
      ? raw(owner, name, kind, [ref, ...rest].join("/"))
      : null;
  }
  if (
    absolute.hostname === "github.com" &&
    sameRepo(owner, name, first, second) &&
    (kind === "blob" || kind === "raw")
  ) {
    return ref === undefined || rest.length === 0 ? null : raw(owner, name, ref, rest.join("/"));
  }
  return null;
};

export const readmeImage = (owner: string, name: string, readme: string): string | null => {
  for (const match of readme.slice(0, readmeScanChars).matchAll(imagePattern)) {
    const src = (match[1] ?? match[2] ?? "").trim();
    if (badgePath.test(src) || unusableExtension.test(src.split(/[?#]/)[0] ?? "")) continue;
    const url = inRepoUrl(owner, name, src);
    if (url !== null) return url;
  }
  return null;
};

const homepageUrl = (homepage: string | null) => {
  const url = homepage === null ? null : URL.parse(homepage.includes("://") ? homepage : `https://${homepage}`);
  return url !== null && ownSite(url.href) ? url.href : null;
};

export const candidates = (input: CandidateInput): ReadonlyArray<IconCandidate> => {
  const files = input.iconFiles
    .filter((file) => !templateBlobs.has(file.oid))
    .slice(0, maxRepoFiles)
    .map(
      (file): IconCandidate => ({
        source: "repo-file",
        url: raw(input.owner, input.name, "HEAD", file.name),
        oid: file.oid,
      }),
    );
  const image = input.readme === null ? null : readmeImage(input.owner, input.name, input.readme);
  const homepage = homepageUrl(input.homepage);
  return [
    ...files,
    ...(image === null ? [] : [{ source: "readme-image" as const, url: image }]),
    ...(homepage === null ? [] : [{ source: "homepage" as const, url: homepage }]),
  ];
};
