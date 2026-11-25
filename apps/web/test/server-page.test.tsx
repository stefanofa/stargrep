import "./client-branch.ts";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { hydrate } from "@tanstack/react-router/ssr/client";
import { act, waitFor } from "@testing-library/react";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { hydrateRoot, type Root } from "react-dom/client";
import { loadEngine } from "../src/lib/engine.ts";
import { getLibrary } from "../src/lib/library-collection.ts";
import { pause } from "../src/lib/search-stream.ts";
import { browserClient, holdSecondPage, requested, searched } from "./page-api.ts";

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
  readonly headers: Readonly<Record<string, string>>;
  readonly cacheControl: string | null;
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
  searched.length = 0;
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

// The names of the places a page marks current in its main navigation, the header's and the phone's tab bar.
const lit = (html: string) => {
  const page = new DOMParser().parseFromString(html, "text/html");
  for (const hidden of page.querySelectorAll("[aria-hidden=true]")) hidden.remove();
  return Array.from(page.querySelectorAll('nav[aria-label="Main"] [aria-current="page"]'), (link) => link.textContent);
};
const statusText = () => document.querySelector("[data-reveal-tile] [role=status]")?.textContent ?? "";
const heading = (name: string) =>
  [...document.querySelectorAll("h2")].some((element) => element.textContent === name) ? name : undefined;
const rail = () => document.querySelector("[role=progressbar]")?.getAttribute("aria-valuetext");
const resultNames = () =>
  Array.from(document.querySelectorAll("main ol li h3"), (heading) => heading.textContent?.trim() ?? "");
const searchValue = () => (document.querySelector("[data-reveal-tile] input") as HTMLInputElement | null)?.value;

// Every distinct status and result list the page showed from now until stop.
const watchScreen = () => {
  const now = () => ({ status: statusText(), results: resultNames().join(", ") });
  const shown = new Map([[JSON.stringify(now()), now()]]);
  const watching = new MutationObserver(() => shown.set(JSON.stringify(now()), now()));
  watching.observe(document.body, { subtree: true, childList: true, characterData: true });
  return {
    now,
    stop: () => {
      watching.disconnect();
      return [...shown.values()];
    },
  };
};

// The demo's planned answer for this shared link's query sits in the API's answer cache, stored minutesAgo before the
// render. No keyword in it matches a star, so only that answer names mobile-mcp.
const cachedPath = "/stefanofa?q=phone%20automation";
const cachedSearch = (minutesAgo: number) => ({
  STARGREP_CACHED_SEARCH: JSON.stringify({ q: "phone automation", minutesAgo }),
});

// The server asks the API for a viewer only when the request carries a session cookie.
const session = "better-auth.session_token=signed";

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
      await getLibrary("stefanofa", "public", false).whole;
    });
    // The browser loads the library from the same API and derives the view live. Nothing on screen changes.
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

  test("the demo landing's own query is the one answer the server searches for, and a filtered link runs none", async () => {
    const page = await renderOnServer("/");
    expect(page.searched).toEqual(["let an ai agent control my iphone"]);
    for (const path of ["/@stefanofa?starred=2026-03", "/?topic=react", "/stefanofa?lang=Rust", "/?archived=true"]) {
      const filtered = await renderOnServer(path);
      const box = filtered.html.match(/<input[^>]*type="search"[^>]*>/)?.[0] ?? "";
      expect([path, filtered.searched, box.includes("let an ai agent")]).toEqual([path, [], false]);
    }
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
    watching.disconnect();
    expect([...shown]).toEqual(["found 1!"]);
    expect(errors).toEqual([]);
  }, 60_000);

  test("a shared link paints the answer by meaning the API cache holds for it, and searches nothing on the server", async () => {
    const cases = [
      ["/stefanofa?q=phone%20automation", undefined, "miss"],
      ["/stefanofa?q=phone%20automation", 1, "hit"],
      ["/stefanofa?q=Phone%20%20Automation", 6, "stale"],
      ["/stefanofa?q=phone%20automation", 24 * 60 + 6, "miss"],
      ["/octodone?q=phone%20automation", 1, "miss"],
    ] as const;
    for (const [path, minutesAgo, outcome] of cases) {
      const page = await renderOnServer(path, undefined, minutesAgo === undefined ? {} : cachedSearch(minutesAgo));
      // No keyword matches the query, so only the answer by meaning names mobile-mcp.
      expect([
        path,
        minutesAgo,
        page.headers["x-answer-cache"],
        page.html.includes(">mobile-mcp</a>"),
        page.searched,
      ]).toEqual([path, minutesAgo, outcome, outcome !== "miss", []]);
    }
  }, 60_000);

  test("a fresh cached answer hydrates as painted, and the browser never asks for it again", async () => {
    const page = await renderOnServer(cachedPath, undefined, cachedSearch(1));
    const router = await hydratePage(cachedPath, page.html);
    const loaded = router.state.matches.at(-1)?.loaderData as { first: { hits: { stale: boolean } } } | undefined;
    expect(loaded?.first.hits.stale).toBe(false);
    const shown = watchScreen();
    expect(shown.now()).toEqual({ status: "found 1!", results: "mobile-mcp" });
    // The browser asks only once typing pauses, so the page waits past that before it checks no search ran.
    await act(() => Effect.runPromise(Effect.sleep(Duration.times(pause, 2))));
    expect([shown.stop(), searched, errors]).toEqual([[{ status: "found 1!", results: "mobile-mcp" }], [], []]);
  }, 60_000);

  test("a stale cached answer stays on screen while the browser asks for it again", async () => {
    const page = await renderOnServer(cachedPath, undefined, cachedSearch(6));
    const router = await hydratePage(cachedPath, page.html);
    const loaded = router.state.matches.at(-1)?.loaderData as { first: { hits: { stale: boolean } } } | undefined;
    expect(loaded?.first.hits.stale).toBe(true);
    const shown = watchScreen();
    expect(shown.now()).toEqual({ status: "found 1!", results: "mobile-mcp" });
    await waitFor(() => expect(searched).toEqual(["phone automation"]));
    expect([shown.stop(), errors]).toEqual([[{ status: "found 1!", results: "mobile-mcp" }], []]);
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
    expect(page.html).toMatch(/<h1[^>]*>@octosync<\/h1>/);
    expect(page.html).toContain("stars arriving");
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

  test("a shared link whose library the server can't read in time paints without it, and the browser loads it", async () => {
    const path = "/stefanofa?q=terminal&repo=asciinema%2Fasciinema";
    const page = await renderOnServer(path, undefined, { STARGREP_HELD_STARS: "1" });
    expect(page.status).toBe(200);
    expect(page.html).not.toContain("found 1");
    expect(page.html).not.toContain(">asciinema</a>");

    await hydratePage(path, page.html);
    await waitFor(() => expect(statusText()).toBe("found 1!"));
    await waitFor(() => expect(document.querySelector("[role=dialog] h2")?.textContent).toBe("asciinema"));
    expect(errors).toEqual([]);
  }, 60_000);

  test("a visitor's home lights home, and the footer's source link paints its count from the server", async () => {
    const sourceLink = () => document.querySelector(`footer a[href="${"https://github.com/stefanofa/stargrep"}"]`);
    const page = await renderOnServer("/", undefined, { STARGREP_HEADER_STARS: "1234" });
    expect(lit(page.html)).toEqual(["home"]);
    await hydratePage("/", page.html);
    expect(sourceLink()?.textContent).toBe("source ★ 1.2k stars");
    expect(errors).toEqual([]);

    const countless = await renderOnServer("/stefanofa?q=terminal");
    expect(countless.status).toBe(200);
    expect(countless.html).toContain(">source <");
    expect(countless.html).not.toContain("1.2k");
  }, 60_000);

  test("a signed-in viewer's own page paints their person tile, the ring on you and the account row from the server, and hydrates without a change", async () => {
    const page = await renderOnServer("/", session, { STARGREP_SIGNED_IN: "octodone" });
    expect(page.status).toBe(200);
    expect(page.html).toContain('aria-label="Search your stars"');
    expect(page.html.match(/<h1[^>]*>[^<]*<\/h1>/g)).toEqual([expect.stringContaining(">@octodone</h1>")]);
    expect(page.html).toMatch(/<nav aria-label="your page"[^>]*>.*<a [^>]*aria-current="page"[^>]*href="\/"/);
    expect(lit(page.html)).toEqual(["you", "you"]);
    expect(page.html).toContain("only you see this");
    expect(page.requested).toEqual([]);

    process.env.STARGREP_SIGNED_IN = "octodone";
    try {
      await hydratePage("/", page.html);
      // The owner's page asks for a sync on every open, and lists the stars of the session's own library.
      await waitFor(() => expect(requested).toEqual(["octodone"]));
      await waitFor(() => expect(resultNames()).toEqual(["mobile-mcp", "fzf", "asciinema"]));
      expect(document.querySelector("nav[aria-label='your page'] a")?.getAttribute("aria-current")).toBe("page");
      expect(lit(document.documentElement.outerHTML)).toEqual(["you", "you"]);
      expect(errors).toEqual([]);
    } finally {
      delete process.env.STARGREP_SIGNED_IN;
    }
  }, 60_000);

  test("a signed-in viewer on someone else's page gets the person, not the landing", async () => {
    const page = await renderOnServer("/stefanofa?q=terminal", session, { STARGREP_SIGNED_IN: "octodone" });
    expect(page.html).toContain('aria-label="Search @stefanofa&#x27;s stars"');
    expect(lit(page.html)).toEqual([]);
    expect(page.html).not.toContain("only you see this");
    expect(page.html.match(/<h1[^>]*>[^<]*<\/h1>/g)).toEqual([expect.stringContaining(">@stefanofa</h1>")]);
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
    expect(page.html).toContain("stars arriving");
    expect(page.html).not.toContain("is this you? skip the wait");
    expect(page.html).not.toContain("stargrep:revealed");
    expect(page.requested).toEqual([]);

    await hydratePage("/fresh-login", page.html);
    await waitFor(() => expect(requested).toEqual(["fresh-login"]));
    expect(errors).toEqual([]);
  }, 60_000);

  test("a refused import is remembered: the reload paints the refusal and asks no one again", async () => {
    const first = await renderOnServer("/ghost-login");
    await hydratePage("/ghost-login", first.html);
    await waitFor(() => expect(heading("GitHub has no one called @ghost-login")).toBeDefined());
    expect(requested).toEqual(["ghost-login"]);
    const cookie = document.cookie;
    expect(cookie).toContain("stargrep-refused=");
    act(() => root?.unmount());
    root = undefined;

    requested.length = 0;
    const reload = await renderOnServer("/ghost-login", cookie);
    expect(reload.status).toBe(404);
    expect(reload.html).toContain("GitHub has no one called @ghost-login");
    expect(reload.requested).toEqual([]);
    await hydratePage("/ghost-login", reload.html);
    await waitFor(() => expect(heading("GitHub has no one called @ghost-login")).toBeDefined());
    expect(requested).toEqual([]);
  }, 60_000);

  test("a login github didn't have at stargrep's last look answers 404 and paints so, and no one asks again", async () => {
    const page = await renderOnServer("/gone-login");
    expect(page.status).toBe(404);
    expect(page.html).toContain("GitHub has no one called @gone-login");
    expect(page.html).not.toContain("stars arriving");
    expect(page.requested).toEqual([]);
    await hydratePage("/gone-login", page.html);
    await waitFor(() => expect(heading("GitHub has no one called @gone-login")).toBeDefined());
    expect(requested).toEqual([]);
    expect(errors).toEqual([]);
  }, 60_000);

  test("a sign-in github refused paints its problem tile from the server and keeps it once hydrated", async () => {
    const page = await renderOnServer("/?error=access_denied");
    expect(page.html).toContain("you said no to GitHub");
    await hydratePage("/?error=access_denied", page.html);
    await waitFor(() => expect(document.querySelector("[role=alert] button")?.textContent).toContain("try again"));
    expect(document.querySelector("[role=alert] h2")?.textContent).toBe("you said no to GitHub");
    expect(errors).toEqual([]);
  }, 60_000);

  test("an import under way paints the person from the server's status read, and its progress once hydrated", async () => {
    const page = await renderOnServer("/octosync");
    expect(page.html).toContain("stars arriving");
    expect(page.html).toMatch(/<h1[^>]*>@octosync<\/h1>/);
    expect(page.requested).toEqual([]);
    await hydratePage("/octosync", page.html);
    await waitFor(() => expect(rail()).toBe("2 of 10 imported"));
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
    expect(page.html).toContain(">reload</button>");
    expect(page.html).not.toContain("Something went wrong!");
    expect(page.html).toContain("$_TSR");
    expect(page.html).not.toContain(secret);
  }, 60_000);

  test("the hero's username field goes to that login's stars before the page hydrates", async () => {
    const landing = await renderOnServer("/");
    const form = landing.html.match(/<form[^>]*aria-label="Whose stars"[^>]*>.*?<\/form>/s)?.[0] ?? "";
    expect(form).toMatch(/action="\/"/);
    expect(form).toMatch(/method="get"/);
    expect(form).toMatch(/<input[^>]*name="user"/);
    for (const [typed, location] of [
      ["+%40octosync+", "/octosync"],
      ["api", "/@api"],
    ] as const) {
      const sent = await renderOnServer(`/?user=${typed}`);
      expect([sent.status >= 300 && sent.status < 400, sent.location]).toEqual([true, location]);
    }
    const nonsense = await renderOnServer("/?user=not+a+login");
    expect(nonsense.status).toBe(200);
  }, 60_000);

  test("a login named like a stargrep path lives at /@login, which any login can use", async () => {
    const redirected = await renderOnServer("/api?q=rust");
    expect(redirected.status).toBeGreaterThanOrEqual(300);
    expect(redirected.status).toBeLessThan(400);
    expect(redirected.location).toBe("/@api?q=rust");
    const reserved = await renderOnServer("/@api");
    expect(reserved.html).toMatch(/<h1[^>]*>@api<\/h1>/);
    const anyone = await renderOnServer("/@octosync");
    expect(anyone.html).toMatch(/<h1[^>]*>@octosync<\/h1>/);
  }, 60_000);
});

describe("the following pages", () => {
  test("tell every cache to store none of them, signed out or in", async () => {
    for (const [path, cookie, env] of [
      ["/following", undefined, {}],
      ["/following", session, { STARGREP_SIGNED_IN: "octodone" }],
      ["/following/people", session, { STARGREP_SIGNED_IN: "octodone" }],
    ] as const) {
      const page = await renderOnServer(path, cookie, env);
      expect([path, page.status, page.cacheControl]).toEqual([path, 200, "private, no-store"]);
    }
    expect((await renderOnServer("/people")).cacheControl).not.toBe("private, no-store");
  }, 60_000);
});

describe("the taste page", () => {
  test("a shared link paints the charts from the server, every mark a link into the stars it counts", async () => {
    const page = await renderOnServer("/@stefanofa/taste");
    expect(page.status).toBe(200);
    // A chart that throws on the server hands the page to the browser without a word, but for React's note.
    expect(page.html.match(/Switched to client rendering[^"]*/)?.[0]).toBeUndefined();
    for (const href of ["/stefanofa?starred=2026-10", "/stefanofa?starred=2026-11", "/stefanofa?lang=TypeScript"])
      expect(page.html).toContain(`href="${href}"`);
    expect(page.html).toContain('href="/stefanofa?topic=mcp"');
    // The person's tabs paint with taste current, and stars leads back to the stars page with their count.
    const tabs = page.html.match(/<nav aria-label="@stefanofa&#x27;s page".*?<\/nav>/)?.[0] ?? "";
    expect(
      [...tabs.matchAll(/<a [^>]*>/g)].map(([link]) => [
        link.match(/href="([^"]*)"/)?.[1],
        link.includes("aria-current"),
      ]),
    ).toEqual([
      ["/stefanofa", false],
      ["/@stefanofa/taste", true],
    ]);
    const unread = await renderOnServer("/@octonever/taste");
    expect(unread.html).toContain('href="/octonever"');
    expect(unread.html).not.toContain("stars per month");
  }, 60_000);
});
