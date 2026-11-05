import { describe, expect, test } from "bun:test";
import { audit, budget, type Chunk } from "../scripts/landing-budget.ts";

const chunk = (fileName: string, moduleIds: Array<string>, extra: Partial<Chunk> = {}): Chunk => ({
  fileName,
  code: `export const name = ${JSON.stringify(fileName)};`,
  isEntry: false,
  imports: [],
  moduleIds,
  ...extra,
});

const app = "/repo/apps/web/src";
const effect = "/repo/node_modules/.bun/effect@4.1.2/node_modules/effect/dist/Effect.js";

describe("the landing budget", () => {
  test("counts the entry, the index route and what they import, and nothing the search route loads alone", () => {
    const report = audit([
      chunk("index.js", [`${app}/router.tsx`], { isEntry: true, imports: ["shared.js"] }),
      chunk("shared.js", ["/repo/packages/ui/src/mark/pip.tsx"]),
      chunk("routes.js", [`${app}/routes/index.tsx?tsr-split=component`], { imports: ["shared.js"] }),
      chunk("search.js", [`${app}/routes/search.tsx?tsr-split=component`, effect]),
    ]);
    expect(report.chunks.map((entry) => entry.fileName)).toEqual(["index.js", "shared.js", "routes.js"]);
    expect(report.found).toEqual([]);
    expect(report.total).toBe(report.chunks.reduce((sum, entry) => sum + entry.gzipped, 0));
  });

  test("names each forbidden package by module path, however the code was minified", () => {
    const report = audit([
      chunk("index.js", [`${app}/router.tsx`, effect], { isEntry: true, imports: ["helper.js"] }),
      chunk("helper.js", [
        "/repo/node_modules/.bun/@tanstack+db@1.0.0/node_modules/@tanstack/db/dist/index.js",
        "/repo/node_modules/.bun/skullet@0.0.3/node_modules/skullet/dist/react/index.mjs",
        "/repo/node_modules/.bun/@orpc+client@2.0.0/node_modules/@orpc/client/dist/index.mjs",
      ]),
    ]);
    expect(report.found.map((hit) => [hit.name, hit.fileName])).toEqual([
      ["Effect", "index.js"],
      ["TanStack DB", "helper.js"],
      ["skullet", "helper.js"],
      ["oRPC client", "helper.js"],
    ]);
  });

  test("the router and a package whose name starts with effect are not mistaken for forbidden code", () => {
    const report = audit([
      chunk(
        "index.js",
        [
          "/repo/node_modules/.bun/@tanstack+react-router@1/node_modules/@tanstack/react-router/dist/index.js",
          "/repo/node_modules/.bun/effect-tsgo@1/node_modules/effect-tsgo/index.js",
        ],
        { isEntry: true },
      ),
    ]);
    expect(report.found).toEqual([]);
  });

  test("the budget is 130,000 bytes of gzipped JS", () => {
    expect(budget).toBe(130_000);
  });
});
