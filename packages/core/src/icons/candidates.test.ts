import { describe, expect, test } from "bun:test";
import { rankIconFiles } from "@stargrep/github/icon-files";
import { TreeEntry } from "@stargrep/github/readme";
import { ObjectId, RepoFacts } from "@stargrep/github/schemas";
import * as Schema from "effect/Schema";
import { candidates, readmeImage } from "./candidates.ts";
import samples from "./fixtures/samples.json";
import { iconRequest } from "./icon-queue.ts";

const decodeEntries = Schema.decodeUnknownSync(Schema.Array(TreeEntry));
const decodeFacts = Schema.decodeUnknownSync(RepoFacts);

const sample = (fullName: string) => {
  const found = samples.find((entry) => `${entry.owner}/${entry.name}` === fullName);
  if (found === undefined) throw new Error(`no sample ${fullName}`);
  return found;
};

const factsOf = (fullName: string) => {
  const repo = sample(fullName);
  return decodeFacts({
    id: 1,
    nodeId: "R_1",
    owner: repo.owner,
    name: repo.name,
    description: null,
    homepage: repo.homepage,
    language: null,
    license: null,
    topics: [],
    createdAt: "2026-01-01T00:00:00Z",
    pushedAt: null,
    archived: false,
    fork: false,
    stars: 1,
    forks: 0,
    readme: null,
    iconFiles: rankIconFiles(decodeEntries(repo.entries), repo.name),
    ownerType: repo.ownerType === "Organization" ? "org" : "user",
    ownerAvatarUrl: `https://avatars.githubusercontent.com/${repo.owner}`,
  });
};

const pick = (fullName: string) => ({
  candidates: candidates({ ...iconRequest(factsOf(fullName)), readme: sample(fullName).readme }),
});

const raw = (repo: string, path: string, ref = "HEAD") => `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;

describe("candidates from the report's sample", () => {
  test("antirez/ds4 tries its root logo.svg first, then the same logo through the README", () => {
    expect(pick("antirez/ds4").candidates).toEqual([
      { source: "repo-file", url: raw("antirez/ds4", "logo.svg"), oid: expect.any(String) },
      { source: "readme-image", url: raw("antirez/ds4", "logo.svg") },
    ]);
  });

  test("benjitaylor/drawesome tries its plain logo before the dark variant", () => {
    expect(pick("benjitaylor/drawesome").candidates.map((candidate) => candidate.url)).toEqual([
      raw("benjitaylor/drawesome", "logo.svg"),
      raw("benjitaylor/drawesome", "logo-dark.svg"),
    ]);
  });

  test("README logos in nested folders replace the nested tree lookups, ahead of the homepage", () => {
    expect(pick("shinyobjectz/raea").candidates).toEqual([
      { source: "readme-image", url: raw("shinyobjectz/raea", "docs/logo/cat-black.svg") },
      { source: "homepage", url: "https://raea.io/" },
    ]);
    expect(pick("trycua/cua").candidates[0]).toEqual({
      source: "readme-image",
      url: raw("trycua/cua", "img/logo_black.svg"),
    });
    expect(pick("haydenbleasel/ghost").candidates).toEqual([
      { source: "readme-image", url: raw("haydenbleasel/ghost", ".github/logo.svg") },
    ]);
    expect(pick("heycupola/relic").candidates[0]).toEqual({
      source: "readme-image",
      url: raw("heycupola/relic", "apps/web/public/relic-logo-dark.svg"),
    });
  });

  test("rewrites a github.com raw link to the same repo onto raw.githubusercontent.com at its ref", () => {
    expect(pick("AtomicBot-ai/Atomic-Chat").candidates[0]).toEqual({
      source: "readme-image",
      url: raw("AtomicBot-ai/Atomic-Chat", "assets/logo.png", "main"),
    });
    expect(pick("chdb-io/chdb").candidates[0]).toEqual({
      source: "readme-image",
      url: raw("chdb-io/chdb", "docs/_static/snake-chdb.png", "main"),
    });
  });

  test("skips a README of badges and falls back to the homepage, as for vercel-labs/wterm", () => {
    expect(pick("vercel-labs/wterm").candidates).toEqual([{ source: "homepage", url: "https://wterm.dev/" }]);
  });

  test("a repo with no icon file, README image, or homepage has nothing to fetch", () => {
    expect(pick("TanStack/markdown").candidates).toEqual([]);
    expect(pick("lucataco/open-source-higgsfield").candidates).toEqual([]);
  });
});

describe("candidate rules", () => {
  const base = { owner: "acme", name: "kit", homepage: null, iconFiles: [], readme: null };
  const oid = Schema.decodeSync(ObjectId);

  test("skips a template favicon by its blob ID without downloading it", () => {
    const template = oid("af98450595e8b8efd9e505cddc5ed705b665a4d8");
    expect(
      candidates({
        ...base,
        iconFiles: [
          { name: "favicon.ico", oid: template },
          { name: "icon.png", oid: oid("1".repeat(40)) },
        ],
      }).map((candidate) => candidate.url),
    ).toEqual([raw("acme/kit", "icon.png")]);
  });

  test("skips homepages on GitHub, package registries, and donation or social sites, and adds a scheme to a bare domain", () => {
    expect(candidates({ ...base, homepage: "https://github.com/acme/kit" })).toEqual([]);
    expect(candidates({ ...base, homepage: "https://www.npmjs.com/package/kit" })).toEqual([]);
    expect(candidates({ ...base, homepage: "https://npmjs.org/package/kit" })).toEqual([]);
    expect(candidates({ ...base, homepage: "https://www.patreon.com/bePatron?u=8663953" })).toEqual([]);
    expect(candidates({ ...base, homepage: "https://pkg.go.dev/github.com/acme/kit" })).toEqual([]);
    expect(candidates({ ...base, homepage: "kit.dev" })).toEqual([{ source: "homepage", url: "https://kit.dev/" }]);
    expect(candidates({ ...base, homepage: "acme.github.io/kit" })).toEqual([
      { source: "homepage", url: "https://acme.github.io/kit" },
    ]);
  });

  test("takes the first image in the same repo and passes over badges, GIFs, and other repos", () => {
    const readme = [
      "![CI](https://github.com/acme/kit/actions/workflows/ci.yml/badge.svg)",
      "![stars](https://img.shields.io/github/stars/acme/kit)",
      "![demo](docs/demo.gif)",
      "![other](https://raw.githubusercontent.com/someone/else/main/logo.png)",
      '<img alt="logo" width="96" src="./assets/Logo Mark.png">',
    ].join("\n");
    expect(readmeImage("acme", "kit", readme)).toBe(raw("acme/kit", "assets/Logo%20Mark.png"));
    expect(readmeImage("acme", "kit", "![x](https://github.com/ACME/Kit/blob/v2/img/logo.svg?raw=true)")).toBe(
      raw("acme/kit", "img/logo.svg", "v2"),
    );
    expect(readmeImage("acme", "kit", "![x](https://github.com/user-attachments/assets/123)")).toBeNull();
  });

  test("keeps a path with a bare percent sign as written instead of throwing", () => {
    expect(
      readmeImage("acme", "kit", "![cov](docs/100%.png)\n![logo](https://github.com/acme/kit/raw/main/a%zz.svg)"),
    ).toBe(raw("acme/kit", "docs/100%25.png"));
    expect(readmeImage("acme", "kit", "![logo](docs/my%20logo%20100%.png)")).toBe(
      raw("acme/kit", "docs/my%20logo%20100%25.png"),
    );
  });

  test("looks only at the first 20 KB of a README", () => {
    expect(readmeImage("acme", "kit", `${"x".repeat(20_000)}![logo](logo.png)`)).toBeNull();
  });
});
