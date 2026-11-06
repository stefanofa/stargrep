import { describe, expect, test } from "bun:test";
import { avatarOwners, repoVisual } from "../src/lib/repo-visual.ts";

const repo = {
  owner: "tokio-rs",
  icon: null,
  ownerType: "org" as const,
  ownerAvatarUrl: "https://avatars.githubusercontent.com/u/20248544?v=4",
};

const everyone = new Set(["org", "user"] as const);

describe("the repo icon slot", () => {
  test("the repo's own icon comes first, with its plate", () => {
    const icon = { url: "https://icons.stargrep.com/git/abc.webp", plate: "dark" as const, size: 128 };
    expect(repoVisual({ ...repo, icon })).toEqual({
      kind: "icon",
      url: icon.url,
      plate: "dark",
      size: 128,
      letters: "to",
    });
  });

  test("an org without an icon shows its avatar, asked for at slot size", () => {
    expect(repoVisual(repo)).toEqual({
      kind: "avatar",
      url: "https://avatars.githubusercontent.com/u/20248544?v=4&s=88",
      letters: "to",
    });
  });

  test("a person's repo without an icon shows their avatar", () => {
    expect(avatarOwners.has("user")).toBe(true);
    expect(repoVisual({ ...repo, owner: "ClementTsang", ownerType: "user" })).toMatchObject({
      kind: "avatar",
      letters: "cl",
    });
  });

  test("with only orgs switched on, a person's repo gets a monogram of two lowercase owner letters", () => {
    expect(repoVisual({ ...repo, owner: "ClementTsang", ownerType: "user" }, new Set(["org"] as const))).toEqual({
      kind: "monogram",
      letters: "cl",
    });
  });

  test("a repo the server has not described yet gets a monogram", () => {
    expect(repoVisual({ owner: "x", icon: null, ownerType: null, ownerAvatarUrl: null }, everyone)).toEqual({
      kind: "monogram",
      letters: "x",
    });
  });
});
