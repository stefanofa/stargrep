import { describe, expect, test } from "bun:test";
import { audit, auditEngine, type Chunk } from "../scripts/landing-budget.ts";

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
  test("counts the entry, the index route and their imports, excluding unrelated routes", () => {
    const report = audit([
      chunk("index.js", [`${app}/router.tsx`], { isEntry: true, imports: ["shared.js"] }),
      chunk("shared.js", ["/repo/packages/ui/src/mark/pip.tsx"]),
      chunk("routes.js", [`${app}/routes/{-$login}.tsx?tsr-split=component`], { imports: ["shared.js"] }),
      chunk("settings.js", [`${app}/routes/settings.tsx?tsr-split=component`, effect]),
    ]);
    expect(report.chunks.map((entry) => entry.fileName)).toEqual(["index.js", "shared.js", "routes.js"]);
    expect(report.found).toEqual([]);
    expect(report.total).toBe(report.chunks.reduce((sum, entry) => sum + entry.gzipped, 0));
  });

  test("home hydration loads the engine and its dependencies while the landing budget stays light", () => {
    const chunks = [
      chunk("index.js", [`${app}/router.tsx`, `${app}/routes/{-$login}.tsx`], {
        isEntry: true,
        imports: ["runtime.js"],
      }),
      chunk("runtime.js", ["/runtime.js"]),
      chunk("stars.js", [`${app}/components/stars.tsx`, effect], { imports: ["index.js", "db.js"] }),
      chunk("db.js", ["/repo/node_modules/@tanstack/db/index.js"], { imports: ["runtime.js"] }),
      chunk("settings.js", [`${app}/routes/settings.tsx`]),
    ];
    expect(audit(chunks).chunks.map((entry) => entry.fileName)).toEqual(["index.js", "runtime.js"]);
    const engine = auditEngine(chunks);
    expect(engine.chunks.map((entry) => entry.fileName)).toEqual(["index.js", "runtime.js", "stars.js", "db.js"]);
    expect(engine.total).toBe(engine.chunks.reduce((sum, entry) => sum + entry.gzipped, 0));
    expect(() => auditEngine(chunks.filter((chunk) => chunk.fileName !== "stars.js"))).toThrow("engine moved");
  });

  test("names each forbidden package by module path, however the code was minified", () => {
    const report = audit([
      chunk("index.js", [`${app}/router.tsx`, effect], { isEntry: true, imports: ["helper.js"] }),
      chunk("helper.js", [
        "/repo/node_modules/.bun/@tanstack+db@1.0.0/node_modules/@tanstack/db/dist/index.js",
        "/repo/node_modules/.bun/skullet@0.0.3/node_modules/skullet/dist/react/index.mjs",
        "/repo/node_modules/.bun/@orpc+client@2.0.0/node_modules/@orpc/client/dist/index.mjs",
        "/repo/node_modules/.bun/@base-ui+react@1.9.0/node_modules/@base-ui/react/button/Button.mjs",
      ]),
      chunk("routes.js", [`${app}/routes/{-$login}.tsx`]),
    ]);
    expect(report.found.map((hit) => [hit.name, hit.fileName])).toEqual([
      ["Effect", "index.js"],
      ["TanStack DB", "helper.js"],
      ["skullet", "helper.js"],
      ["oRPC client", "helper.js"],
      ["Base UI", "helper.js"],
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
      chunk("routes.js", [`${app}/routes/{-$login}.tsx`]),
    ]);
    expect(report.found).toEqual([]);
  });

  test("fails when no chunk holds the index route, so a renamed route can't pass on the entry alone", () => {
    expect(() => audit([chunk("index.js", [`${app}/router.tsx`], { isEntry: true })])).toThrow(
      "no chunk holds src/routes/{-$login}.tsx",
    );
  });

  test("fails unless there is exactly one entry chunk", () => {
    const route = chunk("routes.js", [`${app}/routes/{-$login}.tsx`]);
    expect(() => audit([route])).toThrow("expected one entry chunk, found 0");
    expect(() =>
      audit([
        chunk("index.js", [`${app}/router.tsx`], { isEntry: true }),
        chunk("other.js", [`${app}/other.tsx`], { isEntry: true }),
        route,
      ]),
    ).toThrow("expected one entry chunk, found 2");
  });
});
