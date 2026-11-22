import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render as renderInDom, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { after } from "../src/lib/wall-clock.ts";

// The API as the follow controls see it. A follow the test refuses fails like a dropped connection.
const server = {
  following: [{ login: "ada", followedAt: "2026-11-02T10:00:00.000Z" }] as Array<{ login: string; followedAt: string }>,
  refuse: false,
  followed: [] as Array<ReadonlyArray<string>>,
  unfollowed: [] as Array<string>,
};

const api = () => ({
  // The list answers as it stood when asked, after a while, so a follow made meanwhile is newer than it.
  followedLogins: async () => {
    const asked = [...server.following];
    await new Promise((resolve) => after(50, () => resolve(undefined)));
    return { follows: asked };
  },
  follow: async ({ logins }: { logins: ReadonlyArray<string> }) => {
    server.followed.push(logins);
    await new Promise((resolve) => after(0, () => resolve(undefined)));
    if (server.refuse) throw new Error("offline");
    for (const login of logins) server.following.push({ login, followedAt: "2026-11-22T10:00:00.000Z" });
    return { following: [...logins], total: server.following.length, full: false };
  },
  unfollow: async ({ login }: { login: string }) => {
    server.unfollowed.push(login);
    server.following = server.following.filter((follow) => follow.login !== login);
    return { unfollowed: true };
  },
});

// Sign-in posts where to come back to, then leaves for GitHub. The test keeps the address and goes nowhere.
const signedInto: Array<string> = [];
spyOn(globalThis, "fetch").mockImplementation((async (_: unknown, init?: RequestInit) => {
  signedInto.push((JSON.parse(String(init?.body)) as { callbackURL: string }).callbackURL);
  return Response.json({ url: "about:blank" });
}) as typeof fetch);
spyOn(location, "assign").mockImplementation(() => {});

const rpc = await import("../src/lib/rpc.ts");
mock.module("../src/lib/rpc.ts", () => ({ ...rpc, api }));
const { FollowAll, FollowButton, FollowPill } = await import("../src/components/follows.tsx");

// The toast links to the feed, so every control renders inside a router.
const render = (ui: ReactNode) => {
  const root = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [location.pathname + location.search] }),
  });
  return renderInDom(<RouterProvider router={router} />);
};

afterAll(() => mock.restore());

afterEach(() => {
  cleanup();
  server.refuse = false;
  server.followed = [];
  server.unfollowed = [];
  signedInto.length = 0;
});

// A page applies a follow it came back with once per load, so this runs before any other follow control mounts.
describe("coming back from sign-in", () => {
  test("applies the follow once, drops it from the address, and says so", async () => {
    history.replaceState(null, "", "/margaret?follow=margaret");
    render(<FollowButton login="margaret" signedIn />);
    expect(await screen.findByText("you follow @margaret now. their new stars show in following.")).toBeDefined();
    expect(server.followed).toEqual([["margaret"]]);
    expect(location.search).toBe("");
    expect(await screen.findByRole("button", { name: "following @margaret, change" })).toBeDefined();
    expect(screen.getByRole("link", { name: "open following" }).getAttribute("href")).toBe("/following");
  });
});

describe("the follow button", () => {
  test("signed out, it signs in and asks to come back following", async () => {
    const user = userEvent.setup();
    render(<FollowButton login="grace" signedIn={false} />);
    await user.click(await screen.findByRole("button", { name: "+ follow" }));
    await waitFor(() => expect(signedInto).toHaveLength(1));
    expect(new URL(signedInto[0] ?? "", "http://x").searchParams.get("follow")).toBe("grace");
    expect(server.followed).toEqual([]);
  });

  test("follows at once and then offers to unfollow, saying they aren't told", async () => {
    const user = userEvent.setup();
    render(<FollowButton login="linus" signedIn />);
    await user.click(await screen.findByRole("button", { name: "+ follow" }));
    expect(server.followed).toEqual([["linus"]]);
    await user.click(await screen.findByRole("button", { name: "following @linus, change" }));
    expect(await screen.findByText("they aren't told")).toBeDefined();
    await user.click(screen.getByRole("menuitem", { name: "unfollow @linus" }));
    expect(server.unfollowed).toEqual(["linus"]);
    expect(await screen.findByRole("button", { name: "+ follow" })).toBeDefined();
  });

  test("a follow that fails to save flips back and says so", async () => {
    server.refuse = true;
    const user = userEvent.setup();
    render(<FollowButton login="guido" signedIn />);
    await user.click(await screen.findByRole("button", { name: "+ follow" }));
    expect(await screen.findByText("couldn't save that. try again")).toBeDefined();
    expect(screen.getByRole("button", { name: "+ follow" })).toBeDefined();
  });
});

describe("the follow pill", () => {
  test("is its own control, and unfollows at once where the person is followed", async () => {
    const user = userEvent.setup();
    render(<FollowPill login="ada" signedIn />);
    const pill = await screen.findByRole("button", { name: "following @ada, unfollow" });
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    await user.click(pill);
    expect(server.unfollowed).toEqual(["ada"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "follow @ada" })).toBeDefined());
  });
});

describe("follow all", () => {
  test("follows everyone, then only the others, then confirms quietly", async () => {
    const user = userEvent.setup();
    render(<FollowAll logins={["ken", "dennis"]} signedIn />);
    await user.click(await screen.findByRole("button", { name: "+ follow all 2" }));
    expect(server.followed).toEqual([["ken", "dennis"]]);
    expect(await screen.findByText("following all 2")).toBeDefined();
    cleanup();

    render(<FollowAll logins={["ken", "dennis", "bjarne"]} signedIn />);
    await user.click(await screen.findByRole("button", { name: "+ follow the other 1" }));
    expect(server.followed.at(-1)).toEqual(["bjarne"]);
  });

  test("signed out, it signs in to follow the people it lists", async () => {
    const user = userEvent.setup();
    render(<FollowAll logins={["alan", "edsger"]} signedIn={false} />);
    await user.click(await screen.findByRole("button", { name: "+ follow all 2" }));
    await waitFor(() => expect(signedInto).toHaveLength(1));
    expect(new URL(signedInto[0] ?? "", "http://x").searchParams.get("follow")).toBe("alan,edsger");
  });
});
