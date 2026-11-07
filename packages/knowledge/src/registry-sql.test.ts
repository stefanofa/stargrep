import { describe, expect, test } from "bun:test";
import { renderRegistrySql } from "./registry-sql.ts";

describe("registry.sql", () => {
  // A migration carries this SQL. When the registry changes, run `bun run --cwd packages/knowledge generate`, review the
  // diff, and ship a migration with it.
  test("equals what the registry generates", async () => {
    expect(renderRegistrySql()).toBe(await Bun.file(new URL("./registry.sql", import.meta.url)).text());
  });

  test("reserves exactly the registry's 174 keys", () => {
    const list = /knowledge_reserved_key[\s\S]*?array\[([\s\S]*?)\]\)/.exec(renderRegistrySql())?.[1] ?? "";
    expect([...list.matchAll(/'((?:[^']|'')*)'/g)]).toHaveLength(174);
  });
});
