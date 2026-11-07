import { env } from "cloudflare:workers";
import * as AppJwt from "@stargrep/github/app-jwt";
import * as AppToken from "@stargrep/github/app-token";
import * as Fake from "@stargrep/github/github.fixture";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";

// vitest.config.ts generates this key pair in Node for each run, so no key file exists.
const testKeys = env as unknown as { readonly TEST_APP_PRIVATE_KEY: string; readonly TEST_APP_PUBLIC_KEY: string };

const fromBase64Url = (part: string) =>
  Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

const verifies = async (jwt: string) => {
  const [header = "", payload = "", signature = ""] = jwt.split(".");
  const der = Uint8Array.from(
    atob(testKeys.TEST_APP_PUBLIC_KEY.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "")),
    (char) => char.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromBase64Url(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
};

describe("GitHub App tokens on workerd", () => {
  it("imports the PKCS#1 key GitHub hands out and signs a JWT that its public key verifies", async () => {
    expect(testKeys.TEST_APP_PRIVATE_KEY).toContain("BEGIN RSA PRIVATE KEY");
    const jwt = await Effect.runPromise(
      Effect.flatten(
        AppJwt.signer({ clientId: "Iv23liTestClient", privateKey: Redacted.make(testKeys.TEST_APP_PRIVATE_KEY) }),
      ),
    );
    const [, payload = ""] = Redacted.value(jwt).split(".");
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(payload)))).toMatchObject({ iss: "Iv23liTestClient" });
    expect(await verifies(Redacted.value(jwt))).toBe(true);
  });

  it("mints an installation token with workerd's WebCrypto and sends no secret but the JWT", async () => {
    const fake = Fake.make((sent) =>
      sent.url.pathname === "/app"
        ? { body: { owner: { login: "stefanofa", type: "User" } } }
        : sent.url.pathname === "/users/stefanofa/installation"
          ? { body: { id: 7 } }
          : { status: 201, body: { token: "ghs_workerd", expires_at: "2099-01-01T00:00:00Z" } },
    );
    const token = await Effect.runPromise(
      AppToken.makeInstallationTokens({
        credentials: { clientId: "Iv23liTestClient", privateKey: Redacted.make(testKeys.TEST_APP_PRIVATE_KEY) },
      }).pipe(
        Effect.flatMap((tokens) => tokens.current("owner")),
        Effect.provide(fake.client),
        Effect.scoped,
      ),
    );
    expect(Redacted.value(token)).toBe("ghs_workerd");
    expect(fake.sent.map((sent) => [sent.url.pathname, sent.body ?? null])).toEqual([
      ["/app", null],
      ["/users/stefanofa/installation", null],
      ["/app/installations/7/access_tokens", null],
    ]);
    const jwt = fake.sent[2]?.headers.authorization?.replace("Bearer ", "") ?? "";
    expect(await verifies(jwt)).toBe(true);
  });
});
