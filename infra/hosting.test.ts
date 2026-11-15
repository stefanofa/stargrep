import { expect, test } from "bun:test";
import { previewHost } from "@stargrep/worker/domain";
import * as Effect from "effect/Effect";
import { declare, previewEnv, prodEnv } from "./declare-app.ts";

interface Hosting {
  readonly domain?: { readonly name: string; readonly zoneName: string; readonly redirects?: ReadonlyArray<string> };
  readonly routes?: ReadonlyArray<{ readonly pattern: string; readonly zoneName: string }>;
  readonly workersDev?: boolean;
}

const hostingOf = async (stage: string, env: Readonly<Record<string, string>>) => {
  const { resources } = await Effect.runPromise(declare(stage, env));
  return Object.fromEntries(
    ["Worker", "Web", "DebugWorker"].flatMap((id) => {
      const props = resources[id]?.Props as Hosting | undefined;
      if (props === undefined) return [];
      const { domain, routes, workersDev } = props;
      return [[id, { domain, routes, workersDev }]];
    }),
  );
};

test("a preview serves its web and debug Workers one level under the zone, and no Worker on workers.dev", async () => {
  expect(await hostingOf("pr-7", previewEnv)).toEqual({
    Worker: { domain: undefined, routes: undefined, workersDev: false },
    Web: { domain: { name: "pr-7.stargrep.com", zoneName: "stargrep.com" }, routes: undefined, workersDev: false },
    DebugWorker: {
      domain: { name: "pr-7-debug.stargrep.com", zoneName: "stargrep.com" },
      routes: undefined,
      workersDev: false,
    },
  });
});

test("prod keeps its hostnames, and the preview allowlist passes only a preview's web hostname", async () => {
  const prod = await hostingOf("prod", prodEnv);
  expect(prod).toEqual({
    Worker: {
      domain: { name: "stargrep.com", zoneName: "stargrep.com", redirects: ["www.stargrep.com"] },
      routes: undefined,
      workersDev: false,
    },
    Web: { domain: undefined, routes: [{ pattern: "stargrep.com/*", zoneName: "stargrep.com" }], workersDev: false },
  });
  const preview = await hostingOf("pr-7", previewEnv);
  const hostnames = [
    prod.Worker?.domain?.name,
    ...(prod.Worker?.domain?.redirects ?? []),
    preview.DebugWorker?.domain?.name,
  ];
  expect(hostnames.map((hostname) => [hostname, previewHost.test(hostname ?? "")])).toEqual([
    ["stargrep.com", false],
    ["www.stargrep.com", false],
    ["pr-7-debug.stargrep.com", false],
  ]);
  expect(previewHost.test(preview.Web?.domain?.name ?? "")).toBe(true);
});

test("a local stage keeps alchemy dev's own URLs", async () => {
  expect(await hostingOf("dev_stefano", previewEnv)).toEqual({
    Worker: { domain: undefined, routes: undefined, workersDev: undefined },
    Web: { domain: undefined, routes: undefined, workersDev: undefined },
    DebugWorker: { domain: undefined, routes: undefined, workersDev: undefined },
  });
});
