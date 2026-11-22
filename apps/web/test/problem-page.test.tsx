import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createORPCErrorFromJson } from "@orpc/client";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, configure, render, within } from "@testing-library/react";
import { Failure } from "../src/components/problem-page.tsx";
import { edgeAnswers } from "./edge-answers.ts";

configure({ asyncUtilTimeout: 4000 });

afterEach(cleanup);

// A page whose loader fails with this error, as a topic's page does when the browser asks for it.
const failWith = async (error: () => Promise<unknown>) => {
  const root = createRootRoute({ loader: error, component: () => null, errorComponent: Failure });
  render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory() })} />);
  return within(document.body).findByRole("heading", { level: 2 });
};

describe("the error page", () => {
  spyOn(console, "error").mockImplementation(() => {});

  test("blames stargrep for a failure on its side, and offers a reload", async () => {
    expect((await failWith(() => Promise.reject(new Error("boom")))).textContent).toBe("stargrep tripped");
    expect(within(document.body).getByRole("button", { name: "reload" })).toBeTruthy();
  });

  test("tells a network that asked too often to wait, from the API or the zone", async () => {
    const limited = createORPCErrorFromJson({
      defined: true,
      code: "TOO_MANY_REQUESTS",
      message: "slow down",
      data: undefined,
    });
    expect((await failWith(() => Promise.reject(limited))).textContent).toBe("lots of requests from your network");
    cleanup();
    const zone = () => edgeAnswers(429).topic({ topic: "tui" });
    expect((await failWith(zone)).textContent).toBe("lots of requests from your network");
    expect(within(document.body).getByRole("button", { name: "try again" })).toBeTruthy();
  });

  test("says the visitor is offline rather than that stargrep broke", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      expect((await failWith(() => Promise.reject(new TypeError("Failed to fetch")))).textContent).toBe(
        "you're offline",
      );
    } finally {
      Reflect.deleteProperty(navigator, "onLine");
    }
  });
});
