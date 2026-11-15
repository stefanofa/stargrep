import { expect, test } from "bun:test";
import { readManifest, staleRepos } from "./sync-repos.ts";

test("repos/VENDORED.json pins the tag, paths, and excludes that sync-repos.ts fetches", async () => {
  const manifest = await readManifest();
  expect(staleRepos(manifest)).toEqual([]);
  for (const pinned of Object.values(manifest)) expect(pinned.commit).toMatch(/^[0-9a-f]{40}$/);
});
