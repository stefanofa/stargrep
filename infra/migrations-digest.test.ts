import { expect, test } from "bun:test";
import { migrationsDigest } from "@stargrep/worker/database";

const hashes = Object.fromEntries(
  Array.from({ length: 400 }, (_, index) => [`2026${String(index).padStart(10, "0")}_step`, "f".repeat(64)]),
);

test("binds a short digest of the migrations that changes when any one does", () => {
  const digest = migrationsDigest(hashes);
  expect(digest.length).toBeLessThan(64);
  expect(digest.startsWith("400:20260000000399_step:")).toBe(true);
  expect(migrationsDigest({ ...hashes, "20260000000007_step": "e".repeat(64) })).not.toBe(digest);
  expect(migrationsDigest(Object.fromEntries(Object.entries(hashes).reverse()))).toBe(digest);
});
