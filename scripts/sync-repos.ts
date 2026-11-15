import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";
import rootPackage from "../package.json" with { type: "json" };

type Repo = {
  readonly name: string;
  readonly url: string;
  readonly tag: string;
  readonly paths: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
};

type Pinned = Omit<Repo, "name"> & { readonly commit: string };

const { catalog } = rootPackage.workspaces;

export const repos: ReadonlyArray<Repo> = [
  {
    name: "effect",
    url: "https://github.com/Effect-TS/effect.git",
    tag: `effect@${catalog.effect}`,
    paths: [
      "LICENSE",
      "LLMS.md",
      "README.md",
      "MIGRATION.md",
      "ai-docs",
      "packages/effect/LICENSE",
      "packages/effect/README.md",
      "packages/effect/THIRD_PARTY_NOTICES.md",
      "packages/effect/ARBITRARY.md",
      "packages/effect/CONFIG.md",
      "packages/effect/HTTPAPI.md",
      "packages/effect/MCP.md",
      "packages/effect/OPTIC.md",
      "packages/effect/SCHEMA.md",
      "packages/effect/src",
      "packages/effect/test",
      "packages/vitest/src",
      "packages/vitest/test",
    ],
    exclude: [],
  },
  {
    name: "orpc",
    url: "https://github.com/middleapi/orpc.git",
    tag: "v2.0.0-beta.48",
    paths: [
      "LICENSE",
      "README.md",
      "apps/content/docs",
      ...["contract", "server", "client", "openapi", "effect", "mcp", "shared"].map((name) => `packages/${name}/src`),
    ],
    exclude: [],
  },
  {
    name: "alchemy",
    url: "https://github.com/alchemy-run/alchemy-effect.git",
    tag: "v2.0.0-beta.85",
    paths: [
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_LICENSES.md",
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
    exclude: ["**/.env", "**/.env.*"],
  },
];

export const manifestPath = join(import.meta.dir, "..", "repos", "VENDORED.json");

export const readManifest = async (): Promise<Record<string, Pinned>> =>
  JSON.parse(await readFile(manifestPath, "utf8"));

export const staleRepos = (manifest: Record<string, Pinned>) =>
  repos
    .filter(({ name, ...wanted }) => {
      const { commit: _, ...pinned } = manifest[name] ?? {};
      return JSON.stringify(pinned) !== JSON.stringify(wanted);
    })
    .map((repo) => repo.name);

const usage = `Usage: bun scripts/sync-repos.ts [--update] [--into <dir>]

Without flags, fetches each repo in repos/VENDORED.json into repos/ and fails when a tag no longer points at the pinned commit.
--update  fetches the tags this script names and pins their commits in repos/VENDORED.json.
--into    writes the copies to another folder instead of repos/.`;

const main = async () => {
  const { values } = parseArgs({
    options: { update: { type: "boolean", default: false }, into: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) return console.log(usage);

  const manifest = await readManifest();
  const stale = staleRepos(manifest);
  if (!values.update && stale.length > 0) {
    throw new Error(
      `repos/VENDORED.json is out of date for ${stale.join(", ")}. Run bun scripts/sync-repos.ts --update.`,
    );
  }

  const root = resolve(values.into ?? join(import.meta.dir, "..", "repos"));
  await mkdir(root, { recursive: true });
  const workdir = await mkdtemp(join(tmpdir(), "sync-repos-"));
  try {
    const fetched = await Promise.all(
      repos.map(async (repo) => {
        const clone = join(workdir, repo.name);
        await $`git -c advice.detachedHead=false clone --quiet --depth 1 --filter=blob:none --sparse --branch ${repo.tag} ${repo.url} ${clone}`;
        const commit = (await $`git -C ${clone} rev-parse HEAD`.text()).trim();
        const pinned = manifest[repo.name]?.commit;
        if (!values.update && commit !== pinned) {
          throw new Error(`${repo.name} tag ${repo.tag} points at ${commit}, but repos/VENDORED.json pins ${pinned}.`);
        }
        const patterns = [...repo.paths.map((path) => `/${path}`), ...repo.exclude.map((glob) => `!${glob}`)];
        await $`git -C ${clone} sparse-checkout set --no-cone ${patterns}`;
        return { repo, clone, commit };
      }),
    );
    for (const { repo, clone, commit } of fetched) {
      const target = join(root, repo.name);
      await rm(target, { recursive: true, force: true });
      for (const path of repo.paths) await cp(join(clone, path), join(target, path), { recursive: true });
      console.log(`${target} at ${repo.tag} (${commit})`);
    }
    if (values.update) {
      const pins = Object.fromEntries(
        fetched.map(({ repo: { name, ...source }, commit }) => [name, { ...source, commit }]),
      );
      await writeFile(manifestPath, `${JSON.stringify(pins, null, 2)}\n`);
    }
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
};

if (import.meta.main) await main();
