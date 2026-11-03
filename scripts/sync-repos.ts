import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

type Repo = {
  readonly name: string;
  readonly url: string;
  readonly tag: string;
} & (
  | { readonly kind: "subset"; readonly paths: ReadonlyArray<string>; readonly exclude: ReadonlyArray<string> }
  | { readonly kind: "subtree" }
);

type Entry = Omit<Repo, "name"> & { readonly commit: string };

const repos: ReadonlyArray<Repo> = [
  {
    name: "effect",
    kind: "subset",
    url: "https://github.com/Effect-TS/effect.git",
    tag: "effect@4.1.2",
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
    name: "alchemy",
    kind: "subset",
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
  {
    name: "orpc",
    kind: "subtree",
    url: "https://github.com/middleapi/orpc.git",
    tag: "v2.0.0-beta.48",
  },
];

const root = join(import.meta.dir, "..", "repos");
const manifest = join(root, "VENDORED.json");

const syncSubset = async (repo: Extract<Repo, { kind: "subset" }>): Promise<string> => {
  const clone = await mkdtemp(join(tmpdir(), `sync-${repo.name}-`));
  try {
    await $`git -c advice.detachedHead=false clone --quiet --depth 1 --filter=blob:none --sparse --branch ${repo.tag} ${repo.url} ${clone}`;
    const patterns = [...repo.paths.map((path) => `/${path}`), ...repo.exclude.map((glob) => `!${glob}`)];
    await $`git -C ${clone} sparse-checkout set --no-cone ${patterns}`;
    const target = join(root, repo.name);
    await rm(target, { recursive: true, force: true });
    for (const path of repo.paths) await cp(join(clone, path), join(target, path), { recursive: true });
    return (await $`git -C ${clone} rev-parse HEAD`.text()).trim();
  } finally {
    await rm(clone, { recursive: true, force: true });
  }
};

const subtreeCommit = async (repo: Repo): Promise<string> => {
  const log = await $`git log -1 --grep=${`^git-subtree-dir: repos/${repo.name}$`} --format=%B`.text();
  const commit = /^git-subtree-split: ([0-9a-f]{40})$/m.exec(log)?.[1];
  if (commit === undefined) throw new Error(`No git subtree commit found for repos/${repo.name}`);
  return commit;
};

const names = process.argv.slice(2);
const unknown = names.filter((name) => !repos.some((repo) => repo.name === name));
if (unknown.length > 0) {
  throw new Error(`Unknown repo: ${unknown.join(", ")}. Known: ${repos.map((r) => r.name).join(", ")}`);
}

const entries: Record<string, Entry> = await readFile(manifest, "utf8").then(
  (text) => JSON.parse(text),
  () => ({}),
);
for (const repo of repos.filter((r) => names.length === 0 || names.includes(r.name))) {
  const { name, ...entry } = repo;
  const commit = repo.kind === "subset" ? await syncSubset(repo) : await subtreeCommit(repo);
  entries[name] = { ...entry, commit };
  console.log(`repos/${name} at ${repo.tag} (${commit})`);
}
const sorted = Object.fromEntries(
  repos.flatMap((repo) => (entries[repo.name] ? [[repo.name, entries[repo.name]]] : [])),
);
await writeFile(manifest, `${JSON.stringify(sorted, null, 2)}\n`);
