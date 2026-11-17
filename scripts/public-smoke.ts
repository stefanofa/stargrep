import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { type Answer, readAnswer } from "./fresh-stage.ts";

const SyncState = Schema.Struct({ state: Schema.Literal("unknown") });

type Send = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<Answer, HttpClientError.HttpClientError, HttpClient.HttpClient>;

// A new stage passes a send that tries a call again while Cloudflare still answers for its new Worker. Prod sends each
// call once, because there such an answer reaches users.
export const publicSmoke = Effect.fn("StageSmoke.public")(function* (origin: string, send: Send = readAnswer) {
  const get = (path: string) => send(HttpClientRequest.get(new URL(path, origin)));
  const health = yield* get("/health");
  const status = yield* get(`/api/sync/smoke-${yield* Clock.currentTimeMillis}`);
  const state = yield* Schema.decodeEffect(Schema.fromJsonString(SyncState))(status.body);
  return [
    { check: "public health reads the database", ok: health.status === 200, detail: { status: health.status } },
    {
      check: "public sync status reads an unknown login without starting work",
      ok: status.status === 200 && state.state === "unknown",
      detail: { status: status.status, state: state.state },
    },
  ];
});
