import { env } from "cloudflare:workers";
import type { GitHubSignIn } from "@stargrep/auth/config";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { layerAuthRequest, layerRequest } from "../src/server/layers.ts";
import { makeAuthServer, makeServer } from "../src/server/serve.ts";
import { ada, type TokenExchange } from "./fake-github.ts";

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
  const config = { secret: Redacted.make(`auth-secret ${origin}`), github };
  const stageEnv = { ...env, DATABASE: database };
  const auth = makeAuthServer(
    (request) => Option.some(layerAuthRequest(stageEnv, Option.none(), config, request)),
    Layer.empty,
  );
  const api = makeServer((request) => layerRequest(stageEnv, Option.none(), Option.some(config), request), Layer.empty);
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
  return { origin, send };
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
    body: JSON.stringify({ provider: "github", callbackURL: "/search", errorCallbackURL: "/" }),
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

const tokenExchanges = async (): Promise<ReadonlyArray<TokenExchange>> =>
  // @effect-diagnostics-next-line globalFetch:off - the fake GitHub behind the outbound service reports what it was sent.
  (await fetch("https://fake-github.test/exchanges")).json();

const json = async (response: Response) => [response.status, await response.json()] as const;

describe("direct sign-in", () => {
  it("signs in with GitHub, imports the account, and queues its sync", async () => {
    const authorize = await startSignIn(local);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe("http://localhost:1340/auth/callback/github");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

    const callback = await visit(local, githubReturn(authorize, { code: ada.code }));
    expect([callback.status, location(callback).pathname]).toEqual([302, "/search"]);
    expect(await tokenExchanges()).toEqual([
      {
        clientSecret: "client-secret-local",
        redirectUri: "http://localhost:1340/auth/callback/github",
        codeVerifier: true,
      },
    ]);

    expect(await json(await local.send("/api/viewer"))).toEqual([
      200,
      { login: "ada", name: "Ada Lovelace", avatarUrl: ada.user.avatar_url, starredCount: ada.starredCount },
    ]);
    expect(await json(await local.send("/api/library"))).toEqual([200, { repos: [] }]);
    expect((await json(await local.send("/api/sync/ada")))[1]).toMatchObject({ login: "ada", state: "queued" });
  });

  it("sends a denied consent back to the landing page with the error", async () => {
    const authorize = await startSignIn(local);
    const callback = await visit(local, githubReturn(authorize, { error: "access_denied" }));
    expect(callback.status).toBe(302);
    expect([location(callback).pathname, location(callback).searchParams.get("error")]).toEqual(["/", "access_denied"]);
    expect(await tokenExchanges()).toEqual([]);
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
    await tokenExchanges();
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
    expect(await tokenExchanges()).toEqual([
      {
        clientSecret: Redacted.value(prodSecret),
        redirectUri: "https://stargrep.com/auth/callback/github",
        codeVerifier: true,
      },
    ]);

    const signedIn = await visit(preview, completion);
    expect([signedIn.status, location(signedIn).pathname]).toEqual([302, "/search"]);
    expect((await json(await preview.send("/api/viewer")))[1]).toMatchObject({ login: "ada" });
    expect(await json(await prod.send("/api/viewer"))).toEqual([
      401,
      expect.objectContaining({ code: "UNAUTHORIZED" }),
    ]);
  });

  it("answers 404 to a forged completion on prod", async () => {
    for (const path of ["/auth/callback/github/oauth-proxy", "/auth/oauth-proxy-callback"]) {
      const forged = await prod.send(`${path}?callbackURL=%2Fsearch&profile=forged`);
      expect([path, forged.status]).toEqual([path, 404]);
    }
  });

  it("refuses to forward a sign-in to a host that is not a preview of this account", async () => {
    const attacker = stage("https://attacker.example", databases.AUTH_PREVIEW_DATABASE, proxiedThroughProd);
    const authorize = await startSignIn(attacker);
    const forwarded = await visit(prod, githubReturn(authorize, { code: ada.code }));
    expect(forwarded.status).toBe(302);
    expect(location(forwarded).href).toBe("https://stargrep.com/?error=redirect_refused");
    expect(forwarded.headers.get("location")).not.toContain("profile=");
    await tokenExchanges();
  });
});
