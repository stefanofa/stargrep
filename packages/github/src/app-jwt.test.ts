// @effect-diagnostics nodeBuiltinImport:off - the test checks WebCrypto's signature with Node's verifier.

import { describe, expect } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { effect } from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as AppJwt from "./app-jwt.ts";

const pkcs1 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const pkcs8 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const clientId = "Iv23liTestClient";
const now = Date.parse("2026-11-06T12:00:00Z");

const decodePart = (part: string | undefined) => JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));

const verified = (jwt: string, publicKey: string) => {
  const [header, payload, signature] = jwt.split(".");
  return verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature ?? "", "base64url"));
};

describe("AppJwt.signer", () => {
  effect("signs an RS256 JWT with the client ID as issuer, a minute in the past, expiring within ten minutes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      for (const [privateKey, publicKey, other] of [
        [pkcs1.privateKey, pkcs1.publicKey, pkcs8.publicKey],
        [pkcs8.privateKey, pkcs8.publicKey, pkcs1.publicKey],
      ] as const) {
        const sign = yield* AppJwt.signer({ clientId, privateKey: Redacted.make(privateKey) });
        const jwt = Redacted.value(yield* sign);
        const [header, payload] = jwt.split(".");
        expect(decodePart(header)).toEqual({ alg: "RS256", typ: "JWT" });
        expect(decodePart(payload)).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: clientId });
        expect(verified(jwt, publicKey)).toBe(true);
        expect(verified(jwt, other)).toBe(false);
      }
    }),
  );

  effect("fails with AppKeyInvalid for a key that does not import, and names no key", () =>
    Effect.gen(function* () {
      const sign = yield* AppJwt.signer({
        clientId,
        privateKey: Redacted.make("-----BEGIN RSA PRIVATE KEY-----\nbm90IGEga2V5\n-----END RSA PRIVATE KEY-----"),
      });
      const error = yield* Effect.flip(sign);
      expect(error._tag).toBe("AppKeyInvalid");
      expect(JSON.stringify(error)).not.toContain("BEGIN");
    }),
  );
});
