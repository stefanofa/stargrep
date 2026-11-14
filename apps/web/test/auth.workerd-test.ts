import { env } from "cloudflare:workers";
import type { GitHubSignIn } from "@stargrep/auth/config";
import { acquirePool } from "@stargrep/db/node-postgres";
import { BudgetShare } from "@stargrep/github/schemas";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { layerAuthRequest, layerRequest } from "../src/server/layers.ts";
import { makeAuthServer } from "../src/server/serve.ts";
import { ada, type TokenExchange } from "./fake-github.ts";
import { testServer } from "./serve.ts";

const share = BudgetShare.make(0.5);

interface AuthTestEnv {
  readonly AUTH_LOCAL_DATABASE: Hyperdrive;
  readonly AUTH_PROD_DATABASE: Hyperdrive;
  readonly AUTH_PREVIEW_DATABASE: Hyperdrive;
}

const databases = env as unknown as AuthTestEnv;

const clientId = "Iv1.test";
const prodSecret = Redacted.make("client-secret-prod");
const proxySecret = Redacted.make("proxy-secret");

const stage = (origin: string, database: Hyperdrive, github: GitHubSignIn) => {
  const config = {
    secret: Redacted.make(`auth-secret ${origin}`),
    github,
    previewHost: /^stargrep-web-pr-\d+-[a-z0-9]+\.rewebdotso\.workers\.dev$/,
  };
  const stageEnv = { ...env, DATABASE: database };
  const auth = makeAuthServer(
    (request) =>
      Option.some(
        layerAuthRequest(
          stageEnv,
          { ai: { provider: "gateway", key: Option.none() }, budgetShare: share, auth: config },
          request,
        ),
      ),
    Layer.empty,
  );
  const api = testServer((request) =>
    layerRequest(
      stageEnv,
      { ai: { provider: "gateway", key: Option.none() }, budgetShare: share, auth: Option.some(config) },
      request,
    ),
  );
  const cookies = new Map<string, string>();
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    headers.set("cookie", Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; "));
    const request = new Request(new URL(path, origin), { ...init, headers, redirect: "manual" });
    const response = await (auth(request) ?? api(request) ?? Response.json({ unrouted: path }, { status: 404 }));
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const [name = "", value = ""] = pair.split(/=(.*)/s);
      if (value === "" || /max-age=0/i.test(header)) cookies.delete(name);
      else cookies.set(name, value);
    }
    return response;
  };
  return { origin, send, github, cookies };
};

type Stage = ReturnType<typeof stage>;

const local = stage("http://localhost:1340", databases.AUTH_LOCAL_DATABASE, {
  _tag: "direct",
  clientId,
  clientSecret: Redacted.make("client-secret-local"),
  proxySecret: Option.none(),
});

const prodOrigin = "https://stargrep.com";

const prod = stage(prodOrigin, databases.AUTH_PROD_DATABASE, {
  _tag: "direct",
  clientId,
  clientSecret: prodSecret,
  proxySecret: Option.some(proxySecret),
});

const proxiedThroughProd = { _tag: "proxied", clientId, productionOrigin: prodOrigin, proxySecret } as const;

const preview = stage(
  "https://stargrep-web-pr-29-abc123.rewebdotso.workers.dev",
  databases.AUTH_PREVIEW_DATABASE,
  proxiedThroughProd,
);

const startSignIn = async (from: Stage) => {
  const response = await from.send("/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "github", callbackURL: "/", errorCallbackURL: "/" }),
  });
  expect(response.status).toBe(200);
  const { url } = (await response.json()) as { url: string };
  return new URL(url);
};

const githubReturn = (authorize: URL, answer: Record<string, string>) => {
  const target = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  target.searchParams.set("state", authorize.searchParams.get("state") ?? "");
  for (const [key, value] of Object.entries(answer)) target.searchParams.set(key, value);
  return target;
};

const visit = (at: Stage, url: URL | string) => {
  const target = new URL(url, at.origin);
  expect(target.origin).toBe(at.origin);
  return at.send(`${target.pathname}${target.search}`);
};

const location = (response: Response) => new URL(response.headers.get("location") ?? "", "http://unset");

const githubSaw = async (): Promise<{ exchanges: ReadonlyArray<TokenExchange>; viewerReads: number }> =>
  // @effect-diagnostics-next-line globalFetch:off - the fake GitHub behind the outbound service reports what it was sent.
  (await fetch("https://fake-github.test/report")).json();

const sessionCookie = (response: Response) =>
  response.headers.getSetCookie().some((cookie) => cookie.includes("session_token="));

const linkedAccounts = (database: Hyperdrive, providerId: string) =>
  Effect.runPromise(
    acquirePool(database.connectionString).pipe(
      Effect.flatMap((pool) =>
        Effect.promise(() =>
          pool.query<{ count: number }>("select count(*)::int as count from account where provider_id = $1", [
            providerId,
          ]),
        ),
      ),
      Effect.map(({ rows }) => rows[0]?.count),
      Effect.scoped,
    ),
  );

const execute = (database: Hyperdrive, text: string) =>
  Effect.runPromise(
    acquirePool(database.connectionString).pipe(
      Effect.flatMap((pool) => Effect.promise(() => pool.query(text))),
      Effect.scoped,
    ),
  );

const encoder = new TextEncoder();

// Better Auth derives each proxy key with HKDF-SHA256 over the proxy secret, as in better-auth/dist/crypto/purpose.mjs.
const proxyKey = async (purpose: string) => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(Redacted.value(proxySecret)), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("better-auth:oauth-encryption:v1"),
      info: encoder.encode(`better-auth:${purpose}:v1`),
    },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const forgedProfile = async (state: string, email: string) =>
  symmetricEncrypt({
    key: await proxyKey("oauth-proxy-profile"),
    data: JSON.stringify({
      userInfo: { id: "attacker-1", email, name: "Attacker", emailVerified: true },
      account: { providerId: "x", accountId: "attacker-1", accessToken: "stolen" },
      state,
      callbackURL: "/",
      timestamp: DateTime.toEpochMillis(DateTime.nowUnsafe()),
    }),
  });

const forgedCompletion = (profile: string) =>
  `/auth/callback/x/oauth-proxy?callbackURL=%2F&profile=${encodeURIComponent(profile)}`;

const json = async (response: Response) => [response.status, await response.json()] as const;

const syncStatus = async (response: Response) =>
  (await response.json()) as { readonly state: string; readonly requestedAt: string; readonly syncedAt: string };

describe("direct sign-in", () => {
  it("signs in with GitHub, imports the account, and queues its sync", async () => {
    const authorize = await startSignIn(local);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:1340/auth/callback/github");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

    const callback = await visit(local, githubReturn(authorize, { code: ada.code }));
    expect([callback.status, location(callback).pathname]).toEqual([302, "/"]);
    expect(await githubSaw()).toEqual({
      exchanges: [
        {
          clientSecret: "client-secret-local",
          redirectUri: "http://localhost:1340/auth/callback/github",
          codeVerifier: true,
        },
      ],
      viewerReads: 1,
    });
    expect((await json(await local.send("/api/sync/ada")))[1]).toMatchObject({ login: "ada", state: "queued" });

    expect(await json(await local.send("/api/viewer"))).toEqual([
      200,
      { login: "ada", name: "Ada Lovelace", avatarUrl: ada.user.avatar_url, starredCount: ada.starredCount },
    ]);
    expect(await json(await local.send("/api/library"))).toEqual([200, { repos: [], labels: {} }]);
    expect((await githubSaw()).viewerReads).toBe(0);
  });

  it("reads the viewer without a sync, and queues the owner's own a minute after the last one, inside anyone's wait", async () => {
    await visit(local, githubReturn(await startSignIn(local), { code: ada.code }));
    await githubSaw();
    await execute(
      databases.AUTH_LOCAL_DATABASE,
      `update github_accounts set stars_synced_at = now() - interval '2 minutes',
         stars_full_synced_at = now() - interval '2 minutes' where login = 'ada';
       update sync_requests set requested_at = now() - interval '3 minutes', starts_at = now() - interval '3 minutes'
         where login = 'ada'`,
    );
    const before = await syncStatus(await local.send("/api/sync/ada"));
    expect(before).toMatchObject({ state: "done" });

    expect((await local.send("/api/viewer")).status).toBe(200);
    expect(await syncStatus(await local.send("/api/sync/ada"))).toMatchObject({ state: "done" });

    const opened = await syncStatus(await local.send("/api/sync/ada", { method: "POST" }));
    expect(opened).toMatchObject({ state: "queued", syncedAt: before.syncedAt });
    expect(Date.parse(opened.requestedAt)).toBeGreaterThan(Date.parse(before.syncedAt));

    const again = await syncStatus(await local.send("/api/sync/ada", { method: "POST" }));
    expect(again).toMatchObject({ state: "queued", requestedAt: opened.requestedAt });
  });

  it("sends a denied consent back to the landing page with the error", async () => {
    const authorize = await startSignIn(local);
    const callback = await visit(local, githubReturn(authorize, { error: "access_denied" }));
    expect(callback.status).toBe(302);
    expect([location(callback).pathname, location(callback).searchParams.get("error")]).toEqual(["/", "access_denied"]);
    expect(await githubSaw()).toEqual({ exchanges: [], viewerReads: 0 });
  });

  it("ends the session on sign-out", async () => {
    const authorize = await startSignIn(local);
    await visit(local, githubReturn(authorize, { code: ada.code }));
    expect((await local.send("/api/viewer")).status).toBe(200);
    expect((await local.send("/auth/sign-out", { method: "POST" })).status).toBe(200);
    expect(await json(await local.send("/api/library"))).toEqual([
      401,
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    ]);
    await githubSaw();
  });

  it("refuses a GitHub link from a signed-out session that the cookie cache still holds", async () => {
    const browser = stage(local.origin, databases.AUTH_LOCAL_DATABASE, local.github);
    await visit(browser, githubReturn(await startSignIn(browser), { code: ada.code }));
    await githubSaw();
    const linkGitHub = () =>
      browser.send("/auth/link-social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "github", callbackURL: "/" }),
      });
    expect(await json(await linkGitHub())).toEqual([
      200,
      expect.objectContaining({ url: expect.stringMatching(/^https:\/\/github\.com\/login\/oauth\/authorize\?/) }),
    ]);

    const copied = new Map(browser.cookies);
    expect((await browser.send("/auth/sign-out", { method: "POST" })).status).toBe(200);
    for (const [name, value] of copied) browser.cookies.set(name, value);
    expect(await json(await linkGitHub())).toEqual([401, expect.objectContaining({ code: "UNAUTHORIZED" })]);
  });
});

describe("sign-in proxied through prod", () => {
  it("lets prod exchange the code and creates the session on the preview only", async () => {
    const authorize = await startSignIn(preview);
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://stargrep.com/auth/callback/github");

    const forwarded = await visit(prod, githubReturn(authorize, { code: ada.code }));
    expect(forwarded.status).toBe(302);
    const completion = location(forwarded);
    expect([completion.origin, completion.pathname]).toEqual([preview.origin, "/auth/callback/github/oauth-proxy"]);
    expect(await githubSaw()).toEqual({
      exchanges: [
        {
          clientSecret: Redacted.value(prodSecret),
          redirectUri: "https://stargrep.com/auth/callback/github",
          codeVerifier: true,
        },
      ],
      viewerReads: 0,
    });

    const signedIn = await visit(preview, completion);
    expect([signedIn.status, location(signedIn).pathname]).toEqual([302, "/"]);
    expect((await githubSaw()).viewerReads).toBe(1);
    expect((await json(await preview.send("/api/viewer")))[1]).toMatchObject({ login: "ada" });
    expect(await json(await prod.send("/api/viewer"))).toEqual([
      401,
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    ]);
  });

  it("turns no profile forged with the proxy secret into a prod session, under any provider id", async () => {
    await visit(prod, githubReturn(await startSignIn(prod), { code: ada.code }));
    await githubSaw();

    const onPreview = stage(preview.origin, databases.AUTH_PREVIEW_DATABASE, proxiedThroughProd);
    const packaged = (await startSignIn(onPreview)).searchParams.get("state") ?? "";
    const { state: previewState } = JSON.parse(
      await symmetricDecrypt({ key: await proxyKey("oauth-proxy-package"), data: packaged }),
    );
    const accepted = await onPreview.send(forgedCompletion(await forgedProfile(previewState, "attacker@example.com")));
    expect([accepted.status, sessionCookie(accepted)]).toEqual([302, true]);

    const onProd = stage(prodOrigin, databases.AUTH_PROD_DATABASE, prod.github);
    const prodState = (await startSignIn(onProd)).searchParams.get("state") ?? "";
    for (const path of [
      forgedCompletion(await forgedProfile(prodState, ada.email)),
      `/auth/callback/github/oauth-proxy?callbackURL=%2F&profile=${encodeURIComponent(await forgedProfile(prodState, ada.email))}`,
      `/auth/oauth-proxy-callback?callbackURL=%2F&profile=${encodeURIComponent(await forgedProfile(prodState, ada.email))}`,
    ]) {
      const refused = await onProd.send(path);
      expect([path.split("?")[0], refused.status, sessionCookie(refused)]).toEqual([path.split("?")[0], 404, false]);
    }
    expect((await onProd.send("/api/viewer")).status).toBe(401);
    expect(await linkedAccounts(databases.AUTH_PROD_DATABASE, "x")).toBe(0);
    await githubSaw();
  });

  it("refuses to forward a sign-in to a host that is not a preview of this account", async () => {
    const attacker = stage("https://attacker.example", databases.AUTH_PREVIEW_DATABASE, proxiedThroughProd);
    const authorize = await startSignIn(attacker);
    const forwarded = await visit(prod, githubReturn(authorize, { code: ada.code }));
    expect(forwarded.status).toBe(302);
    expect(location(forwarded).href).toBe("https://stargrep.com/?error=redirect_refused");
    expect(forwarded.headers.get("location")).not.toContain("profile=");
    await githubSaw();
  });
});
