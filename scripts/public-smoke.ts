import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";

const SyncState = Schema.Struct({ state: Schema.Literal("unknown") });

export const publicSmoke = Effect.fn("StageSmoke.public")(function* (origin: string) {
  const get = (path: string) => HttpClient.execute(HttpClientRequest.get(new URL(path, origin)));
  const health = yield* get("/health");
  const status = yield* get(`/api/sync/smoke-${yield* Clock.currentTimeMillis}`);
  const state = yield* status.text.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SyncState))));
  return [
    { check: "public health reads the database", ok: health.status === 200, detail: { status: health.status } },
    {
      check: "public sync status reads an unknown login without starting work",
      ok: status.status === 200 && state.state === "unknown",
      detail: { status: status.status, state: state.state },
    },
  ];
}, Effect.timeout("30 seconds"));
