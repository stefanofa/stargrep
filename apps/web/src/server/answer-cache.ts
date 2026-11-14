import type { AnswerCache } from "@stargrep/api/answer-cache";
import { Compile, PlannerPrompt } from "@stargrep/core/search";
import type { SearchModels } from "@stargrep/runtime/ai-key";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// A stored answer carries what planned, compiled, and embedded it, as the stage configures them, so a deploy that
// changes any of them, such as a preview switching providers, misses the old answers.
const versionOf = (models: SearchModels) =>
  encodeURIComponent(`${models.planner}/${PlannerPrompt.version}/${Compile.version}/${models.embedding}`);

// Results carry icon URLs on the request's origin, so each origin keeps its own answers.
export const answerUrl = (origin: string, models: SearchModels, key: string) =>
  `${origin}/answers/${versionOf(models)}/${encodeURIComponent(key)}`;

const storedAtHeader = "x-stored-at";

const cacheFailed = (operation: "get" | "set" | "delete") => (cause: unknown) =>
  Effect.logWarning("Answer cache failed", { operation, cause: String(cause) });

export const makeAnswerCache =
  (cache: () => Promise<Cache>, models: () => SearchModels) =>
  (request: Request): AnswerCache => {
    const origin = new URL(request.url).origin;
    const configured = models();
    const urlOf = (key: string) => answerUrl(origin, configured, key);
    return {
      get: (key) =>
        Effect.tryPromise(async () => {
          const response = await (await cache()).match(urlOf(key));
          if (response === undefined) return Option.none();
          const storedAt = Number(response.headers.get(storedAtHeader));
          const body = await response.text();
          return Number.isSafeInteger(storedAt) ? Option.some({ storedAt, body }) : Option.none();
        }).pipe(Effect.catch((error) => cacheFailed("get")(error.cause).pipe(Effect.as(Option.none())))),
      set: (key, body, keepFor) =>
        Effect.flatMap(Clock.currentTimeMillis, (storedAt) =>
          Effect.tryPromise(async () =>
            (await cache()).put(
              urlOf(key),
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
          await (await cache()).delete(urlOf(key));
        }).pipe(Effect.catch((error) => cacheFailed("delete")(error.cause))),
    };
  };
