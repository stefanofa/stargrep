import { describe, expect } from "bun:test";
import * as GitHubFake from "@stargrep/github/github.fixture";
import { effect } from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as IconHttp from "./icon-http.ts";

const using = (handler: GitHubFake.Handler) => {
  const fake = GitHubFake.make(handler);
  return { sent: fake.sent, layer: IconHttp.layer.pipe(Layer.provide(fake.client)) };
};

const get = (url: string, maxBytes = 1024, overflow: IconHttp.Limit["overflow"] = "miss") =>
  Effect.flatMap(IconHttp.IconHttp, (http) => http.get(url, { maxBytes, overflow }));

describe("IconHttp", () => {
  effect("returns the bytes of a 200 and names itself in the user agent", () => {
    const fake = using(() => ({ body: "<svg></svg>" }));
    return Effect.gen(function* () {
      const download = yield* get("https://raw.githubusercontent.com/acme/kit/HEAD/logo.svg");
      expect(download._tag).toBe("Got");
      expect(new TextDecoder().decode(download._tag === "Got" ? download.bytes : undefined)).toBe("<svg></svg>");
      expect(fake.sent[0]?.headers["user-agent"]).toContain("stargrep");
      expect(download._tag === "Got" ? download.url : download).toBe(
        "https://raw.githubusercontent.com/acme/kit/HEAD/logo.svg",
      );
    }).pipe(Effect.provide(fake.layer));
  });

  effect(
    "reads a 404 as missing, 429 or 5xx as unavailable with any Retry-After delay, and an unresolved origin as a network failure",
    () => {
      const replies: Record<string, GitHubFake.Reply> = {
        "/missing": { status: 404 },
        "/limited": { status: 429, headers: { "retry-after": "120" } },
        "/limited-bare": { status: 429 },
        "/broken": { status: 503 },
        "/dead-domain": { status: 530, body: "error code: 1016" },
        "/origin-530": { status: 530, body: "Site is frozen" },
      };
      const fake = using((sent) => replies[sent.url.pathname] ?? { status: 500 });
      return Effect.gen(function* () {
        expect(yield* get("https://x.dev/missing")).toEqual(IconHttp.Download.Missing({ reason: "status" }));
        expect(yield* get("https://x.dev/limited")).toEqual(
          IconHttp.Download.Unavailable({ reason: "status", status: 429, retryAfterMillis: 120_000 }),
        );
        expect(yield* get("https://x.dev/limited-bare")).toMatchObject({ status: 429, retryAfterMillis: null });
        expect(yield* get("https://x.dev/broken")).toEqual(
          IconHttp.Download.Unavailable({ reason: "status", status: 503, retryAfterMillis: null }),
        );
        expect(yield* get("https://x.dev/dead-domain")).toEqual(
          IconHttp.Download.Unavailable({ reason: "transport", status: 530, retryAfterMillis: null }),
        );
        expect(yield* get("https://x.dev/origin-530")).toEqual(
          IconHttp.Download.Unavailable({ reason: "status", status: 530, retryAfterMillis: null }),
        );
      }).pipe(Effect.provide(fake.layer));
    },
  );

  effect("misses an image past the byte cap, declared or not, and keeps the head of a page past it", () => {
    const body = "x".repeat(2000);
    const fake = using((sent) =>
      sent.url.pathname === "/declared" ? { body, headers: { "content-length": String(body.length) } } : { body },
    );
    return Effect.gen(function* () {
      expect(yield* get("https://x.dev/declared")).toEqual(IconHttp.Download.Missing({ reason: "too-large" }));
      expect(yield* get("https://x.dev/streamed")).toEqual(IconHttp.Download.Missing({ reason: "too-large" }));
      expect((yield* get("https://x.dev/streamed", 4000))._tag).toBe("Got");
      const head = yield* get("https://x.dev/declared", 1500, "truncate");
      expect(head._tag === "Got" ? head.bytes.byteLength : head).toBe(1500);
    }).pipe(Effect.provide(fake.layer));
  });

  effect("keeps a page whose first chunks fill the cap even when the rest of the body stalls", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => controller.enqueue(new TextEncoder().encode("x".repeat(1500))),
            }),
          ),
        ),
      ),
    );
    return Effect.gen(function* () {
      const head = yield* get("https://x.dev/stalls", 1500, "truncate");
      expect(head._tag === "Got" ? head.bytes.byteLength : head).toBe(1500);
    }).pipe(Effect.provide(IconHttp.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))));
  });

  effect("reads a transport error and a body that hangs past the timeout as unavailable", () => {
    const fake = using((sent) =>
      sent.url.pathname === "/down" ? { transportError: "ECONNRESET" } : { stream: "hang" },
    );
    return Effect.gen(function* () {
      expect(yield* get("https://x.dev/down")).toEqual(
        IconHttp.Download.Unavailable({ reason: "transport", status: null, retryAfterMillis: null }),
      );
      const hung = yield* Effect.forkChild(get("https://x.dev/hang"));
      yield* TestClock.adjust(IconHttp.timeout);
      expect(yield* Fiber.join(hung)).toEqual(
        IconHttp.Download.Unavailable({ reason: "timeout", status: null, retryAfterMillis: null }),
      );
    }).pipe(Effect.provide(fake.layer));
  });
});
