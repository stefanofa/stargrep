import "./register.ts";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { hydrate } from "@tanstack/react-router/ssr/client";
import { act, waitFor } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { loadEngine } from "../src/lib/engine.ts";
import { getLibrary } from "../src/lib/library-collection.ts";
import { browserClient, holdSecondPage, requested } from "./page-api.ts";

// A page goes from the Worker to the browser in two steps, and each runs here as it does in production. The server
// step renders in its own process (render-server.tsx) through the real routes, server loaders and in-process API. This
// process then hydrates that HTML with TanStack's dehydrated loader data, as the browser does, with the real engine
// loaded lazily and the same API answering the browser's requests.

const app = new URL("..", import.meta.url).pathname;

interface Rendered {
  readonly status: number;
  readonly location: string | null;
  readonly html: string;
  readonly requested: ReadonlyArray<string>;
  readonly searched: ReadonlyArray<string>;
}

const renderOnServer = async (path: string, cookie?: string, env: Record<string, string> = {}): Promise<Rendered> => {
  const child = Bun.spawn(["bun", "test/render-server.tsx", path, ...(cookie === undefined ? [] : [cookie])], {
    cwd: app,
    env: { ...process.env, SSR: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if ((await child.exited) !== 0) throw new Error(`the server render failed:\n${err}`);
  return JSON.parse(out.trim().split("\n").at(-1) ?? "");
};

mock.module("../src/styles.css?url", () => ({ default: "/styles.css" }));
const rpc = await import("../src/lib/rpc.ts");
// A test can hold the browser's reads of the library, to see what the page shows before it loads.
let libraryHeld: Promise<void> | undefined;
const api = browserClient();
const client = new Proxy(api, {
  get: (target, key) =>
    key === "stars"
      ? async (...args: Parameters<typeof api.stars>) => {
          await libraryHeld;
          return target.stars(...args);
        }
      : Reflect.get(target, key),
});
mock.module("../src/lib/rpc.ts", () => ({ ...rpc, api: () => client }));
const { routeTree } = await import("../src/routeTree.gen.ts");

let root: Root | undefined;
const errors: Array<string> = [];

beforeEach(() => {
  errors.length = 0;
  requested.length = 0;
  spyOn(console, "error").mockImplementation((...args: Array<unknown>) => {
    const message = args.map(String).join(" ");
    // happy-dom loads no stylesheets, and says so for the page's one link.
    if (!message.includes("CSS file loading is disabled")) errors.push(message);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  mock.restore();
  sessionStorage.clear();
  delete document.documentElement.dataset.reveal;
});

// Puts the server's HTML in the document, runs its inline scripts as the parser would, and hydrates it.
const hydratePage = async (path: string, html: string) => {
  history.replaceState(null, "", path);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.documentElement.innerHTML = parsed.documentElement.innerHTML;
  for (const script of Array.from(document.querySelectorAll("script"))) {
    Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
    new Function(script.textContent ?? "")();
  }
  Reflect.deleteProperty(document, "currentScript");
  const router = createRouter({ routeTree });
  await act(async () => {
    await hydrate(router);
    (window as unknown as { $_TSR: { h: () => void } }).$_TSR.h();
    root = hydrateRoot(document, <RouterProvider router={router} />, {
      onRecoverableError: (error) => errors.push(`recoverable: ${String(error)}`),
    });
  });
  return router;
};

const statusText = () => document.querySelector("[role=status]")?.textContent ?? "";
const resultNames = () =>
  Array.from(document.querySelectorAll("main ol li h3"), (heading) => heading.textContent?.trim() ?? "");
const searchValue = () => (document.querySelector("[data-reveal-tile] input") as HTMLInputElement | null)?.value;

describe("a stars page from the Worker to the browser", () => {
  test("the home page paints the demo answer on the server and keeps it once the live library takes over", async () => {
    const page = await renderOnServer("/");
    expect(page.status).toBe(200);
    expect(page.html).toContain("found 1!");
    expect(page.html).toContain(">mobile-mcp</a>");
    expect(page.html).toContain("let an ai agent control my iphone");
    // The engine was loaded before the render, so no boundary waits for it.
    expect(page.html).not.toContain("<!--$?-->");
    expect(page.html).toContain("stargrep:revealed");
    expect(page.requested).toEqual([]);

    sessionStorage.setItem("stargrep:revealed", "1");
    using secondPage = holdSecondPage();
    const router = await hydratePage("/", page.html);
    const loaded = router.state.matches.at(-1)?.loaderData as { first: unknown } | undefined;
    expect(loaded?.first).not.toBeNull();
    const painted = { status: statusText(), results: resultNames(), query: searchValue() };
    const shown = new Set([statusText()]);
    const watching = new MutationObserver(() => shown.add(statusText()));
    watching.observe(document.body, { subtree: true, childList: true, characterData: true });
    expect(painted).toEqual({
      status: "found 1!",
      results: ["mobile-mcp"],
      query: "let an ai agent control my iphone",
    });
    await act(async () => {
      await loadEngine();
    });
    await act(async () => {
      await secondPage.arrived;
    });
    expect({ status: statusText(), results: resultNames(), query: searchValue() }).toEqual(painted);
    await act(async () => {
      secondPage.release();
      await getLibrary("stefanofa", false, false).whole;
    });
    // The browser loads the library from the same API and derives the view live. Nothing on screen changes.
    await waitFor(() =>
      expect(document.querySelector("[role=status]")?.closest("p")?.textContent).toContain("3 stars"),
    );
    watching.disconnect();
    expect({ status: statusText(), results: resultNames(), query: searchValue() }).toEqual(painted);
    // Not even for a moment while the library's first page alone has landed.
    expect([...shown]).toEqual(["found 1!"]);
    expect(errors).toEqual([]);
    expect(requested).toEqual([]);
  }, 60_000);

  test("the demo account in any case is the demo, with its own spelling", async () => {
    const page = await renderOnServer("/StefanoFA");
    expect(page.html).toContain("found 1!");
    expect(page.html).toContain("@stefanofa");
    expect(page.html).not.toContain("@StefanoFA");
  }, 60_000);

  test("the demo landing's own query is the one answer the server searches for", async () => {
    const page = await renderOnServer("/");
    expect(page.searched).toEqual(["let an ai agent control my iphone"]);
  }, 60_000);

  test("a shared link with another query paints its keyword matches and searches nothing on the server", async () => {
    const page = await renderOnServer("/stefanofa?q=terminal");
    expect(page.html).toContain("found 1!");
    expect(page.html).toContain(">asciinema</a>");
    expect(page.html).not.toContain("loading @stefanofa");
    expect(page.searched).toEqual([]);
    // The reveal types the demo's own query, never a shared one.
    expect(page.html).not.toContain("stargrep:revealed");

    const router = await hydratePage("/stefanofa?q=terminal", page.html);
    // The page has no answer by meaning, so the browser searches for one through the API.
    const loaded = router.state.matches.at(-1)?.loaderData as { first: { hits: unknown } | null } | undefined;
    expect(loaded?.first?.hits).toBeNull();
    const shown = new Set([statusText()]);
    const watching = new MutationObserver(() => shown.add(statusText()));
    watching.observe(document.body, { subtree: true, childList: true, characterData: true });
    await waitFor(() =>
      expect(document.querySelector("[role=status]")?.closest("p")?.textContent).toContain("3 stars"),
    );
    watching.disconnect();
    expect([...shown]).toEqual(["found 1!"]);
    expect(errors).toEqual([]);
  }, 60_000);

  test("an HTML request for a new query on another login, or a cold demo query, makes no search and no model call", async () => {
    for (const path of [
      "/octodone?q=a%20sentence%20no%20one%20asked%20before",
      "/stefanofa?q=another%20cold%20sentence",
    ]) {
      const page = await renderOnServer(path);
      expect([path, page.status, page.searched]).toEqual([path, 200, []]);
    }
  }, 60_000);

  test("a login no import has written gets no first answer for a shared query, only its import state", async () => {
    const page = await renderOnServer("/octosync?q=fuzzy");
    expect(page.html).toContain("@octosync is new here.");
    expect(page.html).not.toContain(">fzf</a>");
    expect(page.searched).toEqual([]);
  }, 60_000);

  test("a shared link to a repo opens its panel as the page hydrates, before the library loads", async () => {
    // No other test loads octodone's library, which this process would keep.
    const page = await renderOnServer("/octodone?q=fuzzy&repo=junegunn%2Ffzf");
    expect(page.html).toContain("found 1");
    let release = () => {};
    libraryHeld = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await hydratePage("/octodone?q=fuzzy&repo=junegunn%2Ffzf", page.html);
      // The library's reads are held, so the panel's repo came with the page.
      await waitFor(() => expect(document.querySelector("[role=dialog] h2")?.textContent).toBe("fzf"));
    } finally {
      libraryHeld = undefined;
      release();
    }
    expect(errors).toEqual([]);
  }, 60_000);

  test("a cookie with a broken percent escape counts as no choice, not a failed page", async () => {
    const page = await renderOnServer("/stefanofa?q=terminal", "stargrep-view=%; stargrep-refused=%E0%A4%A");
    expect(page.status).toBe(200);
    expect(page.html).toContain("view-tiles");
  }, 60_000);

  test("the view this browser picked paints from the server, so the page does not switch on hydration", async () => {
    const page = await renderOnServer("/", "stargrep-view=list");
    expect(page.html).toContain("view-list");
    expect(page.html).not.toContain("view-tiles");
  }, 60_000);

  test("a login never synced renders ready to import, and only the hydrated page asks for the import", async () => {
    const page = await renderOnServer("/fresh-login");
    expect(page.html).toContain("ready to import @fresh-login");
    expect(page.html).toContain("is this you? skip the wait");
    expect(page.html).not.toContain("stargrep:revealed");
    expect(page.requested).toEqual([]);

    await hydratePage("/fresh-login", page.html);
    await waitFor(() => expect(requested).toEqual(["fresh-login"]));
    await waitFor(() => expect(statusText()).toContain("importing @fresh-login's stars"));
    expect(errors).toEqual([]);
  }, 60_000);

  test("a refused import is remembered: the reload paints the refusal and asks no one again", async () => {
    const first = await renderOnServer("/ghost-login");
    await hydratePage("/ghost-login", first.html);
    await waitFor(() => expect(statusText()).toBe("no such github user"));
    expect(requested).toEqual(["ghost-login"]);
    const cookie = document.cookie;
    expect(cookie).toContain("stargrep-refused=");
    act(() => root?.unmount());
    root = undefined;

    requested.length = 0;
    const reload = await renderOnServer("/ghost-login", cookie);
    expect(reload.html).toContain("github has no one called @ghost-login");
    expect(reload.requested).toEqual([]);
    await hydratePage("/ghost-login", reload.html);
    await waitFor(() => expect(statusText()).toBe("no such github user"));
    expect(statusText()).toBe("no such github user");
    expect(requested).toEqual([]);
  }, 60_000);

  test("an import under way paints the claim tile from the server's status read, and its progress once hydrated", async () => {
    const page = await renderOnServer("/octosync");
    expect(page.html).toContain("is this you? skip the wait");
    expect(page.html).toContain("@octosync is new here.");
    expect(page.requested).toEqual([]);
    await hydratePage("/octosync", page.html);
    await waitFor(() => expect(statusText()).toContain("importing @octosync's stars"));
    expect(document.querySelector("[role=status]")?.closest("p")?.textContent).toContain("2 of 10");
    expect(requested).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  test("a page whose loader fails sends no word of the error, not even in its hydration data", async () => {
    const secret = "secret detail from the api";
    const page = await renderOnServer("/octosync", undefined, { NODE_ENV: "production", STARGREP_API_FAILURE: secret });
    expect(page.status).toBe(500);
    expect(page.html).toContain("stargrep tripped");
    expect(page.html).toContain("$_TSR");
    expect(page.html).not.toContain(secret);
  }, 60_000);

  test("a page whose own loader fails shows the styled error page, with no word of the error", async () => {
    const secret = "secret detail from the page loader";
    const page = await renderOnServer("/octosync", undefined, {
      NODE_ENV: "production",
      STARGREP_PAGE_FAILURE: secret,
    });
    expect(page.status).toBe(500);
    expect(page.html).toContain("stargrep tripped");
    expect(page.html).toContain(">Reload</button>");
    expect(page.html).not.toContain("Something went wrong!");
    expect(page.html).toContain("$_TSR");
    expect(page.html).not.toContain(secret);
  }, 60_000);

  test("a login named like a stargrep path lives at /@login, which any login can use", async () => {
    const redirected = await renderOnServer("/api?q=rust");
    expect(redirected.status).toBeGreaterThanOrEqual(300);
    expect(redirected.status).toBeLessThan(400);
    expect(redirected.location).toBe("/@api?q=rust");
    const reserved = await renderOnServer("/@api");
    expect(reserved.html).toContain("ready to import @api");
    const anyone = await renderOnServer("/@octosync");
    expect(anyone.html).toContain("@octosync is new here.");
  }, 60_000);
});
