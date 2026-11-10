import { embeddingModel, plannerModel } from "@stargrep/ai/models";
import type { AnswerCache } from "@stargrep/api/answer-cache";
import { Compile, PlannerPrompt } from "@stargrep/core/search";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// A stored answer carries what planned, compiled, and embedded it, so a deploy that changes any of them misses the old
// answers.
const version = encodeURIComponent(`${plannerModel}/${PlannerPrompt.version}/${Compile.version}/${embeddingModel.id}`);

// Results carry icon URLs on the request's origin, so each origin keeps its own answers.
export const answerUrl = (origin: string, key: string) => `${origin}/answers/${version}/${encodeURIComponent(key)}`;

const storedAtHeader = "x-stored-at";

const cacheFailed = (operation: "get" | "set" | "delete") => (cause: unknown) =>
  Effect.logWarning("Answer cache failed", { operation, cause: String(cause) });

export const makeAnswerCache =
  (cache: () => Promise<Cache>) =>
  (request: Request): AnswerCache => {
    const origin = new URL(request.url).origin;
    return {
      get: (key) =>
        Effect.tryPromise(async () => {
          const response = await (await cache()).match(answerUrl(origin, key));
          if (response === undefined) return Option.none();
          const storedAt = Number(response.headers.get(storedAtHeader));
          const body = await response.text();
          return Number.isSafeInteger(storedAt) ? Option.some({ storedAt, body }) : Option.none();
        }).pipe(Effect.catch((error) => cacheFailed("get")(error.cause).pipe(Effect.as(Option.none())))),
      set: (key, body, keepFor) =>
        Effect.flatMap(Clock.currentTimeMillis, (storedAt) =>
          Effect.tryPromise(async () =>
            (await cache()).put(
              answerUrl(origin, key),
              new Response(body, {
                headers: {
                  "content-type": "application/json",
                  "cache-control": `s-maxage=${Math.max(1, Math.ceil(Duration.toSeconds(keepFor)))}`,
                  [storedAtHeader]: String(storedAt),
                },
              }),
            ),
          ),
        ).pipe(Effect.catch((error) => cacheFailed("set")(error.cause))),
      delete: (key) =>
        Effect.tryPromise(async () => {
          await (await cache()).delete(answerUrl(origin, key));
        }).pipe(Effect.catch((error) => cacheFailed("delete")(error.cause))),
    };
  };
