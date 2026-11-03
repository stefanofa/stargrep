import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

type Repo = {
  readonly name: string;
  readonly url: string;
  readonly tag: string;
  readonly paths: ReadonlyArray<string>;
};

const repos: ReadonlyArray<Repo> = [
  {
    name: "effect",
    url: "https://github.com/Effect-TS/effect.git",
    tag: "effect@4.1.2",
    paths: [
      "LICENSE",
      "LLMS.md",
      "README.md",
      "MIGRATION.md",
      "ai-docs",
      "packages/effect/README.md",
      "packages/effect/src",
      "packages/effect/test",
      "packages/vitest/src",
      "packages/vitest/test",
    ],
  },
  {
    name: "alchemy",
    url: "https://github.com/alchemy-run/alchemy-effect.git",
    tag: "v2.0.0-beta.85",
    paths: [
      "LICENSE",
      "NOTICE",
      "README.md",
      "website/src/content/docs",
      "packages/alchemy/src",
      "packages/alchemy/test",
      "packages/cloudflare/README.md",
      "packages/cloudflare/src",
      "packages/neon/README.md",
      "packages/neon/src",
      "packages/github/README.md",
      "packages/github/src",
      "packages/integration-tests/test/Cloudflare",
      "packages/integration-tests/test/Neon",
      "packages/integration-tests/test/GitHub",
    ],
  },
];

const names = process.argv.slice(2);
const unknown = names.filter((name) => !repos.some((repo) => repo.name === name));
if (unknown.length > 0)
  throw new Error(`Unknown repo: ${unknown.join(", ")}. Known: ${repos.map((r) => r.name).join(", ")}`);

for (const repo of repos.filter((r) => names.length === 0 || names.includes(r.name))) {
  const clone = await mkdtemp(join(tmpdir(), `sync-${repo.name}-`));
  try {
    await $`git -c advice.detachedHead=false clone --quiet --depth 1 --filter=blob:none --sparse --branch ${repo.tag} ${repo.url} ${clone}`;
    await $`git -C ${clone} sparse-checkout set --no-cone ${repo.paths.map((path) => `/${path}`)}`;
    const commit = (await $`git -C ${clone} rev-parse HEAD`.text()).trim();
    const target = join(import.meta.dir, "..", "repos", repo.name);
    await rm(target, { recursive: true, force: true });
    for (const path of repo.paths) await cp(join(clone, path), join(target, path), { recursive: true });
    const source = { url: repo.url, tag: repo.tag, commit, paths: repo.paths };
    await writeFile(join(target, "VENDORED.json"), `${JSON.stringify(source, null, 2)}\n`);
    console.log(`repos/${repo.name} synced to ${repo.tag} (${commit})`);
  } finally {
    await rm(clone, { recursive: true, force: true });
  }
}
