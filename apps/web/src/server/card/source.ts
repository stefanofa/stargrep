import * as Effect from "effect/Effect";
import { allStars } from "../../lib/stars-pages.ts";
import { inProcessFor } from "../in-process.ts";
import type { CardSource } from "./account.ts";

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

// GitHub's avatar CDN answers by login without the API, so a card spends none of the server's GitHub budget. A slow or
// odd answer draws the initials instead.
const githubAvatar = async (login: string) => {
  // @effect-diagnostics-next-line globalFetch:off - the card route is plain promise code, like the page loaders around it.
  const response = await fetch(`https://avatars.githubusercontent.com/${login}?size=192`, {
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
  const type = response?.headers.get("content-type");
  if (response === undefined || !response.ok || (type !== "image/png" && type !== "image/jpeg")) return null;
  const body = await response.arrayBuffer().catch(() => undefined);
  return body === undefined ? null : `data:${type};base64,${base64(new Uint8Array(body))}`;
};

// The card reads the API in this Worker as the page does, as the caller that asked for the image. The answer by meaning
// comes from the answer cache alone, so an image never pays for model work.
export const cardSource = (request: Request): CardSource => {
  const client = inProcessFor(request);
  return {
    status: (login) => client.syncStatus({ login }),
    library: (login) => allStars(client, login),
    cachedResults: async (login, query) => {
      const [{ answers }, { cachedSearch }, publicConfig] = await Promise.all([
        import("../app.ts"),
        import("@stargrep/api/router"),
        client.config(),
      ]);
      const input = { scope: { kind: "stars" as const, login }, q: query };
      const cached = await Effect.runPromise(cachedSearch(input, { answerCache: answers(request), publicConfig }));
      return cached.outcome === "miss" ? [] : cached.answer.results;
    },
    avatar: githubAvatar,
  };
};
