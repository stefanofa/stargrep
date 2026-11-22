import * as Effect from "effect/Effect";
import { allStars } from "../../lib/stars-pages.ts";
import { topicSearch } from "../../lib/topic-search.ts";
import { inProcessFor } from "../in-process.ts";
import type { CardSource } from "./account.ts";
import type { TopicCardSource } from "./topic.ts";

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

// The answer by meaning the answer cache holds for a search, or nothing. A topic's card reads the search its page asks.
const cachedResults = async (
  request: Request,
  client: ReturnType<typeof inProcessFor>,
  input:
    | { readonly scope: { readonly kind: "stars"; readonly login: string }; readonly q: string }
    | ReturnType<typeof topicSearch>,
) => {
  const [{ answers }, { cachedSearch }, publicConfig] = await Promise.all([
    import("../app.ts"),
    import("@stargrep/api/router"),
    client.config(),
  ]);
  const cached = await Effect.runPromise(cachedSearch(input, { answerCache: answers(request), publicConfig }));
  return cached.outcome === "miss" ? [] : cached.answer.results;
};

// The card reads the API in this Worker as the page does, as the caller that asked for the image. The answer by meaning
// comes from the answer cache alone, so an image never pays for model work.
export const cardSource = (request: Request): CardSource & TopicCardSource => {
  const client = inProcessFor(request);
  return {
    status: (login) => client.syncStatus({ login }),
    library: (login) => allStars(client, login),
    cachedResults: (login, query) => cachedResults(request, client, { scope: { kind: "stars", login }, q: query }),
    topic: (topic) => client.topic({ topic }),
    cachedTopicResults: (topic, query) => cachedResults(request, client, topicSearch(topic, query)),
    avatar: githubAvatar,
  };
};
