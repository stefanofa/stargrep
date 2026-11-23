import { expect, test } from "bun:test";
import { logoSvgs } from "@stargrep/api/logo-svgs";
import { topicIcon } from "@stargrep/api/topic-icons";
import { topicLogos } from "@stargrep/api/topic-logos";
import { createBuilder } from "vite";

const root = new URL("..", import.meta.url).pathname;

test("the client build ships every topic's logo at the URL its icon names, cached as immutable", async () => {
  const builder = await createBuilder({ root, logLevel: "warn", build: { write: false } });
  const client = builder.environments.client;
  if (client === undefined) throw new Error("vite config has no client environment");
  const result = await builder.build(client);
  const assets = new Map(
    (Array.isArray(result) ? result : [result]).flatMap((output) =>
      "output" in output
        ? output.output.flatMap((item) => (item.type === "asset" ? [[`/${item.fileName}`, String(item.source)]] : []))
        : [],
    ),
  );
  const shipped = Object.entries(topicLogos).map(([topic, { key }]) => {
    const url = topicIcon({ origin: "https://stargrep.test" }, topic, null)?.url ?? "";
    return [topic, assets.get(new URL(url).pathname) === logoSvgs[key] && key in logoSvgs];
  });
  expect(shipped.filter(([, ok]) => !ok)).toEqual([]);
  expect(shipped.length).toBeGreaterThan(500);

  const headers = await Bun.file(`${root}public/_headers`).text();
  expect(headers).toContain("/icons/logos/*\n  Cache-Control: public, max-age=31536000, immutable\n");
}, 60_000);
