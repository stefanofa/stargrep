import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export interface AppCredentials {
  // GitHub recommends the client ID over the app ID as the JWT's issuer.
  readonly clientId: string;
  readonly privateKey: Redacted.Redacted<string>;
}

export class AppKeyInvalid extends Schema.TaggedError<AppKeyInvalid, { readonly brand: unique symbol }>()(
  "AppKeyInvalid",
  {},
) {
  override get message(): string {
    return "The GitHub App's private key does not import or sign";
  }
}

// The private key GitHub hands out is PEM in PKCS#1, and WebCrypto imports RSA private keys only as PKCS#8. PKCS#8 wraps
// the PKCS#1 key in a sequence that names the algorithm, rsaEncryption with null parameters.
const rsaAlgorithmIdentifier = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

const derLength = (length: number): Array<number> => {
  if (length < 0x80) return [length];
  const bytes: Array<number> = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return [0x80 | bytes.length, ...bytes];
};

const derElement = (tag: number, content: ReadonlyArray<number> | Uint8Array) => [
  tag,
  ...derLength(content.length),
  ...content,
];

export const pkcs8FromPkcs1 = (pkcs1: Uint8Array) =>
  new Uint8Array(derElement(0x30, [...derElement(0x02, [0]), ...rsaAlgorithmIdentifier, ...derElement(0x04, pkcs1)]));

const pemBody = (pem: string) => {
  const base64 = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
};

export const importPrivateKey = (pem: Redacted.Redacted<string>) =>
  Effect.tryPromise({
    try: () => {
      const text = Redacted.value(pem);
      const der = text.includes("BEGIN RSA PRIVATE KEY") ? pkcs8FromPkcs1(pemBody(text)) : pemBody(text);
      return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    },
    catch: () => new AppKeyInvalid(),
  });

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const encodeJson = (value: unknown) => base64Url(new TextEncoder().encode(JSON.stringify(value)));

// GitHub asks for iat 60 seconds in the past against clock drift, and an exp at most 10 minutes ahead.
export const signJwt = Effect.fn("AppJwt.sign")(function* (clientId: string, key: CryptoKey) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
  const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({ iat: now - 60, exp: now + 540, iss: clientId })}`;
  const signature = yield* Effect.tryPromise({
    try: () => crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)),
    catch: () => new AppKeyInvalid(),
  });
  return Redacted.make(`${unsigned}.${base64Url(new Uint8Array(signature))}`);
});

export type Signer = Effect.Effect<Redacted.Redacted<string>, AppKeyInvalid>;

// Signs a fresh JWT for each mint, with the key imported once.
export const signer = Effect.fn("AppJwt.signer")(function* (credentials: AppCredentials) {
  const key = yield* Effect.cached(importPrivateKey(credentials.privateKey));
  return Effect.flatMap(key, (imported) => signJwt(credentials.clientId, imported)) satisfies Signer;
});
