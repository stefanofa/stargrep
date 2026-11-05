import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

export type Download = Data.TaggedEnum<{
  Got: { readonly bytes: Uint8Array<ArrayBuffer>; readonly url: string };
  Missing: { readonly reason: "status" | "too-large" };
  Unavailable: {
    readonly reason: "status" | "timeout" | "transport";
    readonly status: number | null;
    readonly retryAfterMillis: number | null;
  };
}>;
export const Download = Data.taggedEnum<Download>();
export type Got = Extract<Download, { readonly _tag: "Got" }>;

export class IconHttp extends Context.Service<
  IconHttp,
  { readonly get: (url: string, limit: Limit) => Effect.Effect<Download> }
>()("@stargrep/core/icons/icon-http/IconHttp") {}

// An image past its limit is not an icon. A page past its limit still has its <head> in the bytes before the limit.
export interface Limit {
  readonly maxBytes: number;
  readonly overflow: "miss" | "truncate";
}

export const timeout = Duration.seconds(10);
const unresolvedOrigin = /error code: 1016/i;

const retryAfterMillis = (header: string | undefined) => {
  const seconds = Number(header);
  return header === undefined || !Number.isFinite(seconds) ? null : Math.max(1, seconds) * 1000;
};

const concat = (chunks: ReadonlyArray<Uint8Array>, total: number) => {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const get = Effect.fn("IconHttp.get")(function* (url: string, { maxBytes, overflow }: Limit) {
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({
        "user-agent": "stargrep-icons (+https://stargrep.com)",
        accept: "image/*,text/html;q=0.9",
      }),
    );
    const download = Effect.gen(function* () {
      const response = yield* client.execute(request);
      // A Workers subrequest to a host that does not resolve gets Cloudflare's 530 with error 1016, not a network error.
      if (response.status === 530 && unresolvedOrigin.test(yield* Effect.orElseSucceed(response.text, () => ""))) {
        return Download.Unavailable({ reason: "transport", status: response.status, retryAfterMillis: null });
      }
      if (response.status === 429 || response.status >= 500) {
        return Download.Unavailable({
          reason: "status",
          status: response.status,
          retryAfterMillis: response.status === 429 ? retryAfterMillis(response.headers["retry-after"]) : null,
        });
      }
      if (response.status < 200 || response.status >= 300) return Download.Missing({ reason: "status" });
      const length = Number(response.headers["content-length"]);
      if (overflow === "miss" && Number.isFinite(length) && length > maxBytes) {
        return Download.Missing({ reason: "too-large" });
      }
      let total = 0;
      const chunks = yield* response.stream.pipe(
        Stream.takeUntil((chunk) => {
          total += chunk.byteLength;
          return overflow === "truncate" ? total >= maxBytes : total > maxBytes;
        }),
        Stream.runCollect,
      );
      const at = response.url || url;
      if (total <= maxBytes) return Download.Got({ bytes: concat(chunks, total), url: at });
      return overflow === "miss"
        ? Download.Missing({ reason: "too-large" })
        : Download.Got({ bytes: concat(chunks, total).slice(0, maxBytes), url: at });
    });
    const outcome = yield* download.pipe(
      Effect.timeoutOption(timeout),
      Effect.orElseSucceed(() =>
        Option.some(Download.Unavailable({ reason: "transport", status: null, retryAfterMillis: null })),
      ),
    );
    return Option.getOrElse(outcome, () =>
      Download.Unavailable({ reason: "timeout", status: null, retryAfterMillis: null }),
    );
  });
  return IconHttp.of({ get });
});

export const layer = Layer.effect(IconHttp, make);
