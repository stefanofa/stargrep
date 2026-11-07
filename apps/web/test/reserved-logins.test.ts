import { describe, expect, test } from "bun:test";
import { isGitHubLogin } from "@stargrep/github/login";
import { reservedLogin } from "../src/lib/search-params.ts";

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

// Every first path segment the Worker or the router answers before a login page could. Read from the source, so a new
// route can't take a GitHub login's page without this test asking for it to be reserved.
const answered = async () => {
  const sources = await Promise.all(
    [
      "../src/server/serve.ts",
      "../src/server/health.ts",
      "../../../packages/api/src/icon-host.ts",
      "../../../packages/auth/src/auth.ts",
    ].map(read),
  );
  const matchers = sources.flatMap((source) =>
    Array.from(
      source.matchAll(/(?:under\(|startsWith\(|pathname === |basePath = |iconsPath = )["`](\/[^"`/]+)/g),
      ([, path]) => path,
    ),
  );
  const routes = Array.from(
    (await read("../src/routeTree.gen.ts")).matchAll(/path: '(\/[^'/$@{]+)'/g),
    ([, path]) => path,
  );
  return [...new Set([...matchers, ...routes])].map((path) => path?.slice(1) ?? "");
};

describe("logins that share a name with a stargrep path", () => {
  test("every path the Worker or the router answers first is reserved", async () => {
    const names = await answered();
    expect(names).toEqual(expect.arrayContaining(["rpc", "api", "mcp", "health", "auth", "icons", "search"]));
    for (const name of names.filter(isGitHubLogin)) expect([name, reservedLogin(name)]).toEqual([name, true]);
  });

  test("reserved names match in any case, and other logins are not reserved", () => {
    expect(reservedLogin("API")).toBe(true);
    expect(reservedLogin("stefanofa")).toBe(false);
  });
});
