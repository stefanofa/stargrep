import { expect, test } from "bun:test";
import { defaultPublicConfig } from "@stargrep/api/public-config";
import { cachedSearch } from "@stargrep/api/router";
import * as Effect from "effect/Effect";
import { topicSearch } from "../src/lib/topic-search.ts";
import { cacheAfter } from "./page-api.ts";

test("a shared topic search's card reads the answer the page's search stored", async () => {
  const answerCache = await cacheAfter(topicSearch("nextjs", "auth libraries"));
  const read = async (input: Parameters<typeof cachedSearch>[0]) =>
    (await Effect.runPromise(cachedSearch(input, { answerCache, publicConfig: defaultPublicConfig }))).outcome;

  expect(await read(topicSearch("nextjs", "auth libraries"))).toBe("hit");
  // The limit is part of the key, so a read with the default limit misses what the page stored.
  expect(await read({ scope: { kind: "topic", topic: "nextjs" }, q: "auth libraries" })).toBe("miss");
});
