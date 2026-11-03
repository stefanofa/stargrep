import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Redacted from "effect/Redacted";
import * as GitHub from "./github.ts";
import type { BudgetShare } from "./schemas.ts";
import * as TokenGate from "./token-gate.ts";

export interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly transportError?: string;
}

export interface Sent {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly startedAt: number;
  readonly signal: AbortSignal;
}

export type Handler = (sent: Sent, index: number) => Effect.Effect<Reply> | Reply;

export const token = "ghp_fake_token_never_logged";

export const rateLimitHeaders = (remaining: number, resetSeconds = 3600, resource = "core") => ({
  "x-ratelimit-resource": resource,
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(resetSeconds),
});

const toResponse = (request: HttpClientRequest.HttpClientRequest, reply: Reply) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(
      reply.body === undefined ? null : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
      { status: reply.status ?? 200, headers: reply.headers ?? {} },
    ),
  );

export const make = (handler: Handler) => {
  const sent: Array<Sent> = [];
  const client = HttpClient.make((request, url, signal) =>
    Effect.gen(function* () {
      const entry: Sent = {
        url,
        headers: request.headers,
        body: request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined,
        startedAt: yield* Clock.currentTimeMillis,
        signal,
      };
      sent.push(entry);
      const planned = handler(entry, sent.length - 1);
      const reply = Effect.isEffect(planned) ? yield* planned : planned;
      if (reply.transportError !== undefined) {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error(reply.transportError) }),
        });
      }
      return toResponse(request, reply);
    }),
  );
  return { sent, client: Layer.succeed(HttpClient.HttpClient, client) };
};

export const layer = (handler: Handler, share = 1 as BudgetShare) => {
  const fake = make(handler);
  const layer = GitHub.layer.pipe(
    Layer.provideMerge(TokenGate.layerMemory({ token: Redacted.make(token), share })),
    Layer.provideMerge(KeyValueStore.layerMemory),
    Layer.provide(fake.client),
  );
  return { sent: fake.sent, layer };
};
