import { Caller } from "@stargrep/api/caller";
import { CallerKey } from "@stargrep/db";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";

// One IPv6 subscriber usually holds a whole /64, so per-caller limits count the /64. Cloudflare sets cf-connecting-ip on
// every request it proxies, so a request without it is local and shares one caller.
export const callerAddress = (request: Request): string => {
  const ip = request.headers.get("cf-connecting-ip");
  if (ip === null) return "unknown";
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
};

const utf8 = new TextEncoder();

// A stored key tells one network from another without naming it: the first 32 hex characters of an HMAC-SHA256 of the
// caller's address under a per-stage secret.
export const layerCaller = (secret: string, request: Request) =>
  Layer.effect(
    Caller,
    Effect.gen(function* () {
      const mac = yield* Mac.Mac;
      const tag = yield* mac.sign(
        yield* Mac.key(Mac.hmacSha256, utf8.encode(secret)),
        utf8.encode(callerAddress(request)),
      );
      return Caller.of({ key: CallerKey.make(Hex.encode(tag).slice(0, 32)) });
    }),
  ).pipe(Layer.provide(Mac.layerWebCrypto), Layer.provide(SecureRandom.layerWebCrypto));
