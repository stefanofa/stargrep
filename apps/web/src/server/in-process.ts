import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { getRequest } from "@tanstack/react-start/server";
import type { Client } from "../lib/rpc.ts";

const forwarded = ["cookie", "cf-connecting-ip", "user-agent"];

// The page calls the API in this Worker, with the visitor's cookie and address, so no request leaves it. The API
// module binds Cloudflare's env, which only the Worker has, so it loads with the first call.
export const inProcess = (): Client => {
  const request = getRequest();
  const headers = Object.fromEntries(
    forwarded.flatMap((name) => {
      const value = request.headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  );
  return createORPCClient(
    new RPCLink({
      url: "/rpc",
      origin: new URL(request.url).origin,
      headers,
      fetch: async (url, init) =>
        (await import("./app.ts")).serveApi(new Request(url, init)) ?? new Response(null, { status: 404 }),
    }),
  );
};
