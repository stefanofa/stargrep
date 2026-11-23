import { describe, expect, test } from "bun:test";
import { bakeTopicLogos } from "../scripts/bake-topic-logos.ts";
import { logoSvgs } from "./logo-svgs.gen.ts";
import { ownsTopic, topicIcon } from "./topic-icons.ts";
import { topicLogos } from "./topic-logos.gen.ts";

const host = { origin: "https://stargrep.test" };
const icon = {
  key: "v2/git/0000000000000000000000000000000000000000.webp",
  source: "homepage",
  plate: "none",
  size: 128,
} as const;

describe("topic logos", () => {
  test("the installed simple-icons still bakes the committed logos", () => {
    const baked = bakeTopicLogos();
    expect(baked.topics).toEqual({ ...topicLogos });
    expect(baked.svgs).toEqual({ ...logoSvgs });
  });

  test("a pale brand color sits on ink, and any other on white", () => {
    expect([topicLogos.javascript?.plate, topicLogos.nextjs?.plate, topicLogos.astro?.plate]).toEqual([
      "dark",
      "light",
      "light",
    ]);
  });
});

describe("topicIcon", () => {
  test("a home repo speaks for its topic only when the project's own org owns it", () => {
    const owned = [
      ["react", "react"],
      ["golang", "go"],
      ["rust-lang", "rust"],
      ["withastro", "astro"],
      ["vuejs", "vue"],
      ["getsentry", "sentry"],
      ["react", "react-native"],
    ];
    const others = [
      ["jenkinsci", "docker"],
      ["TheAlgorithms", "python"],
      ["python-websockets", "websockets"],
      ["golang-jwt", "jwt"],
      ["bitwarden", "android"],
      ["TanStack", "ai"],
    ];
    expect(owned.filter(([owner, topic]) => !ownsTopic(owner as string, topic as string))).toEqual([]);
    expect(others.filter(([owner, topic]) => ownsTopic(owner as string, topic as string))).toEqual([]);
  });

  test("a curated logo beats the home repo's icon, and a topic with neither has none", () => {
    expect(topicIcon(host, "docker", { owner: "jenkinsci", icon })?.url).toBe(
      `https://stargrep.test/icons/logos/${topicLogos.docker?.key}`,
    );
    expect(topicIcon(host, "frida", { owner: "frida", icon })).toEqual({
      url: `https://stargrep.test/icons/${icon.key}`,
      plate: "none",
      size: 128,
    });
    expect(topicIcon(host, "video", { owner: "videolang", icon })).toBeNull();
    expect(topicIcon(host, "frida", { owner: "frida", icon: null })).toBeNull();
    expect(topicIcon(host, "authentication", null)).toBeNull();
  });
});
