import type * as Db from "@stargrep/db";
import { maxIconSize } from "./contract.ts";
import { type IconHost, iconUrl } from "./icon-host.ts";
import { topicLogos } from "./topic-logos.gen.ts";

// Logo files live under /icons/logos/, beside the repo icons, and each name carries a hash of its bytes.
export const logoPrefix = "logos/";
const logoKeyPattern = /^logos\/[a-z0-9]+\.[0-9a-f]{10}\.svg$/;

export const isLogoKey = (key: string) => logoKeyPattern.test(key);

const normalized = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const ownerPrefixes = ["get", "with", "the", "use"];
const ownerSuffixes = [
  "js",
  "lang",
  "hq",
  "io",
  "dev",
  "labs",
  "org",
  "project",
  "team",
  "ai",
  "app",
  "inc",
  "run",
  "sh",
  "land",
  "os",
  "engine",
  "server",
  "rs",
  "ml",
  "hub",
  "community",
];

// The owner's name without the words projects add to their org's, so withastro reads astro and rust-lang reads rust.
const ownerStem = (owner: string) => {
  let stem = normalized(owner);
  const prefix = ownerPrefixes.find((word) => stem.startsWith(word) && stem.length - word.length >= 3);
  if (prefix !== undefined) stem = stem.slice(prefix.length);
  const suffix = ownerSuffixes.find((word) => stem.endsWith(word) && stem.length - word.length >= 2);
  return suffix === undefined ? stem : stem.slice(0, -suffix.length);
};

// A home repo can be any repo named like its topic, such as jenkinsci/docker for docker, so its icon speaks for the topic
// only when the project's own org owns it: react/react for react, golang/go for go, withastro/astro for astro.
export const ownsTopic = (owner: string, topic: string) => {
  const name = normalized(topic);
  const stem = ownerStem(owner);
  return normalized(owner) === name || stem === name || (stem.length >= 3 && name.startsWith(stem));
};

// Homes an owner rule lets through whose icon is another project's.
const blockedHomeIcons = new Set(["crontab", "e2e", "spider", "video", "webui"]);

export interface TopicIcon {
  readonly url: string;
  readonly plate: "none" | "light" | "dark";
  readonly size: number;
}

// A topic's icon: its curated logo, else its home repo's icon when the project's own org owns that repo, else none.
export const topicIcon = (host: IconHost["Service"], topic: string, home: Db.TopicHome | null): TopicIcon | null => {
  const logo = topicLogos[topic];
  if (logo !== undefined)
    return { url: iconUrl(host, `${logoPrefix}${logo.key}`), plate: logo.plate, size: maxIconSize };
  if (home === null || home.icon === null || blockedHomeIcons.has(topic) || !ownsTopic(home.owner, topic)) return null;
  return { url: iconUrl(host, home.icon.key), plate: home.icon.plate, size: home.icon.size };
};
