import * as Analytics from "@stargrep/analytics/analytics";
import { Caller } from "@stargrep/api/caller";
import { CallerKey } from "@stargrep/db";
import * as Mac from "effect/crypto/Mac";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";

// A dotted IPv4 tail, as in ::ffff:192.0.2.1, holds an IPv6 address's last two groups.
const dottedGroups = (part: string) => {
  const [a = 0, b = 0, c = 0, d = 0] = part.split(".").map(Number);
  return [(a << 8) | b, (c << 8) | d];
};

const groupsOf = (ip: string): ReadonlyArray<number> => {
  const parts = (text: string) =>
    text === ""
      ? []
      : text.split(":").flatMap((part) => (part.includes(".") ? dottedGroups(part) : [Number.parseInt(part, 16)]));
  const [head = "", tail] = ip.split("::");
  const left = parts(head);
  const right = tail === undefined ? [] : parts(tail);
  return [...left, ...Array<number>(Math.max(0, 8 - left.length - right.length)).fill(0), ...right];
};

// A network is an IPv4 address, or an IPv6 /64 because one subscriber usually holds a whole /64. An IPv4-mapped IPv6
// address is its IPv4 address. Cloudflare sets cf-connecting-ip on every request it proxies, so a request without it is
// local and shares one network.
export const callerAddress = (request: Request): string => {
  const ip = request.headers.get("cf-connecting-ip");
  if (ip === null) return "unknown";
  if (!ip.includes(":")) return ip;
  const groups = groupsOf(ip.toLowerCase());
  const [high = 0, low = 0] = groups.slice(6);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
};

const utf8 = new TextEncoder();

// A stored key tells one network from another without naming it: the first 32 hex characters of an HMAC-SHA256 of the
// network's address under a per-stage secret.
// Untraced, as it was inside the layer: one HMAC per request would only add a span to every API call.
const callerOf = Effect.fnUntraced(function* (secret: string, request: Request) {
  const mac = yield* Mac.Mac;
  const address = callerAddress(request);
  const tag = yield* mac.sign(yield* Mac.key(Mac.hmacSha256, utf8.encode(secret)), utf8.encode(address));
  return Caller.of({ key: CallerKey.make(Hex.encode(tag).slice(0, 32)), address });
});

const layerCrypto = Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto));

export const layerCaller = (secret: string, request: Request) =>
  Layer.effect(Caller, callerOf(secret, request)).pipe(Layer.provide(layerCrypto));

// Analytics names a request by its network's key, which it hashes again before anything leaves the Worker. A key it
// cannot work out names Stargrep, because analytics never fails a request.
export const layerActor = (secret: string, request: Request) =>
  Layer.effect(
    Analytics.CurrentActor,
    callerOf(secret, request).pipe(
      Effect.map(({ key }): Analytics.Actor => Analytics.Actor.Network({ caller: key })),
      Effect.orElseSucceed(() => Analytics.Actor.Stargrep()),
    ),
  ).pipe(Layer.provide(layerCrypto));
