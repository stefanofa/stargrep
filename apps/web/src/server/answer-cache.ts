import { embeddingModel, plannerModel } from "@stargrep/ai/models";
import type { AnswerCache } from "@stargrep/api/answer-cache";
import { PlannerPrompt } from "@stargrep/core/search";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { RequestLayer } from "./serve.ts";

// A stored answer carries what planned and embedded it, so a deploy that changes either misses the old answers.
const version = encodeURIComponent(`${plannerModel}/${PlannerPrompt.version}/${embeddingModel.id}`);

// Results carry icon URLs on the request's origin, so each origin keeps its own answers.
export const answerUrl = (origin: string, key: string) => `${origin}/answers/${version}/${encodeURIComponent(key)}`;

export interface AnswerCacheRoute {
  readonly cache: () => Promise<Cache>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly layerFor: RequestLayer;
  readonly tracer: Layer.Layer<never>;
}

const storedAtHeader = "x-stored-at";

const refreshTimeout = Duration.seconds(25);

// One refresh per key per isolate at a time.
const refreshing = new Set<string>();

const cacheFailed = (operation: "get" | "set") => (cause: unknown) =>
  Effect.logWarning("Answer cache failed", { operation, cause: String(cause) });

export const makeAnswerCache =
  (route: AnswerCacheRoute) =>
  (request: Request): AnswerCache => {
    const origin = new URL(request.url).origin;
    return {
      get: (key) =>
        Effect.tryPromise(async () => {
          const response = await (await route.cache()).match(answerUrl(origin, key));
          if (response === undefined) return Option.none();
          const storedAt = Number(response.headers.get(storedAtHeader));
          const body = await response.text();
          return Number.isSafeInteger(storedAt) ? Option.some({ storedAt, body }) : Option.none();
        }).pipe(Effect.catch((error) => cacheFailed("get")(error.cause).pipe(Effect.as(Option.none())))),
      set: (key, body, keepFor) =>
        Effect.flatMap(Clock.currentTimeMillis, (storedAt) =>
          Effect.tryPromise(async () =>
            (await route.cache()).put(
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
      refresh: (key, run) =>
        Effect.sync(() => {
          const url = answerUrl(origin, key);
          if (refreshing.has(url)) return;
          refreshing.add(url);
          route.waitUntil(
            Effect.runPromise(
              run.pipe(
                Effect.provide(route.layerFor(request)),
                Effect.timeout(refreshTimeout),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Answer refresh failed", { failure: Cause.hasDies(cause) ? "defect" : "failure" }),
                ),
                Effect.withSpan("Web.answerRefresh"),
                Effect.ensuring(Effect.sync(() => refreshing.delete(url))),
                Effect.provide(route.tracer),
              ),
            ),
          );
        }),
    };
  };
