import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { Client } from "../src/lib/rpc.ts";

// Cloudflare's own HTML page, as its edge answers before any Worker runs: a 429 once prod's zone rate limit blocks an
// address, or a 502 when the Worker can't be reached.
const page = (status: number) =>
  new Response(
    `<!DOCTYPE html><html lang="en-US"><head><title>stargrep.com | ${status}</title></head><body><h1>Error ${status}</h1></body></html>`,
    { status, headers: { "content-type": "text/html; charset=UTF-8" } },
  );

// The browser's real client, answered by Cloudflare's edge instead of the API.
export const edgeAnswers = (status: 429 | 502): Client =>
  createORPCClient(new RPCLink({ url: "/rpc", origin: "http://localhost", fetch: async () => page(status) }));
