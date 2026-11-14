import { expect, test } from "bun:test";
import { type AiSetup, searchModels } from "@stargrep/runtime/ai-key";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makeAnswerCache } from "../src/server/answer-cache.ts";

const memoryCache = () => {
  const responses = new Map<string, Response>();
  return {
    match: async (url: string) => responses.get(url)?.clone(),
    put: async (url: string, response: Response) => {
      responses.set(url, response);
    },
    delete: async (url: string) => responses.delete(url),
  } as unknown as Cache;
};

const gateway: AiSetup = { provider: "gateway", key: Option.none() };
const fake: AiSetup = { provider: "fake" };

test("a stage that switches providers misses the answers the other provider's models stored", async () => {
  const cache = memoryCache();
  let ai: AiSetup = gateway;
  const answers = makeAnswerCache(
    () => Promise.resolve(cache),
    () => searchModels(ai),
  );
  const request = new Request("https://web.example/api/search");
  const key = "search/demo/stars/20//terminal dashboards";
  const read = () => Effect.runPromise(answers(request).get(key));

  await Effect.runPromise(answers(request).set(key, "gateway answer", Duration.minutes(5)));
  expect(Option.map(await read(), (stored) => stored.body)).toEqual(Option.some("gateway answer"));

  ai = fake;
  expect(Option.isNone(await read())).toBe(true);
  await Effect.runPromise(answers(request).set(key, "fake answer", Duration.minutes(5)));
  expect(Option.map(await read(), (stored) => stored.body)).toEqual(Option.some("fake answer"));

  ai = gateway;
  expect(Option.map(await read(), (stored) => stored.body)).toEqual(Option.some("gateway answer"));
});
