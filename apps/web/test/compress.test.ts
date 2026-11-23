import { expect, test } from "bun:test";
import { compressJson } from "../src/server/compress.ts";

const asking = (encoding: string | null) =>
  new Request("https://stargrep.com/rpc/stars", encoding === null ? {} : { headers: { "accept-encoding": encoding } });
const answer = (headers: Record<string, string>, body: string | null = "{}") => new Response(body, { headers });
const json = { "content-type": "application/json", "content-length": "2", vary: "cookie" };

test("a JSON answer leaves the Worker gzipped for a client that takes gzip", async () => {
  const sent = compressJson(asking("br, gzip"), answer(json));
  expect([sent.headers.get("content-encoding"), sent.headers.get("content-length"), sent.headers.get("vary")]).toEqual([
    "gzip",
    null,
    "cookie, accept-encoding",
  ]);
  expect(await sent.json()).toEqual({});
});

test("anything else leaves as it came", () => {
  const unchanged = [
    [asking("br"), answer(json)],
    [asking(null), answer(json)],
    [asking("gzip"), answer({ "content-type": "text/html" })],
    [asking("gzip"), answer({ ...json, "content-encoding": "br" })],
    [asking("gzip"), answer(json, null)],
  ] as const;
  for (const [request, response] of unchanged) expect(compressJson(request, response)).toBe(response);
});
