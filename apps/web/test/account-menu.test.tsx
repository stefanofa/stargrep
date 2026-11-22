import { afterEach, describe, expect, mock, test } from "bun:test";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render as renderInDom, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

// A save the test settles by hand, so it can look at the switch while the request is still out.
interface Pending {
  readonly optedIn: boolean;
  readonly resolve: () => void;
  readonly reject: () => void;
}

const server = { optedIn: false, readFails: false, reads: 0, saves: [] as Array<Pending> };

const api = () => ({
  monthlyPicks: async () => {
    server.reads++;
    if (server.readFails) throw new Error("offline");
    return { optedIn: server.optedIn };
  },
  setMonthlyPicks: ({ optedIn }: { optedIn: boolean }) =>
    new Promise<{ optedIn: boolean }>((resolve, reject) => {
      server.saves.push({
        optedIn,
        resolve: () => {
          server.optedIn = optedIn;
          resolve({ optedIn });
        },
        reject: () => reject(new Error("offline")),
      });
    }),
});

const rpc = await import("../src/lib/rpc.ts");
mock.module("../src/lib/rpc.ts", () => ({ ...rpc, api }));
const { AccountMenu } = await import("../src/components/account-menu.tsx");

// The menu links to places on phones, so it renders inside a router.
const render = (ui: ReactNode) => {
  const root = createRootRoute({ component: () => ui });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  return renderInDom(<RouterProvider router={router} />);
};

afterEach(() => {
  cleanup();
  Object.assign(server, { optedIn: false, readFails: false, reads: 0, saves: [] });
});

const explained = "a short email of repos you'd like, from your stars. no other email.";

const openMenu = async () => {
  const user = userEvent.setup();
  render(<AccountMenu login="ada" avatarUrl={null} />);
  await user.click(await screen.findByRole("button", { name: "Account menu for ada" }));
  const picks = await screen.findByRole("menuitemcheckbox", { name: "monthly picks" });
  return { user, picks };
};

const shown = (picks: HTMLElement) => ({
  checked: picks.getAttribute("aria-checked"),
  disabled: picks.getAttribute("aria-disabled") === "true",
  line: picks.textContent?.replace("monthly picks", ""),
});

describe("monthly picks in the account menu", () => {
  test("reads the opt-in when the menu opens, not before, and explains it", async () => {
    server.optedIn = true;
    render(<AccountMenu login="ada" avatarUrl={null} />);
    expect(server.reads).toBe(0);
    cleanup();

    const { picks } = await openMenu();
    await waitFor(() => expect(shown(picks)).toEqual({ checked: "true", disabled: false, line: explained }));
    expect(server.reads).toBe(1);
  });

  test("switches on at once, stays on once saved, and opening again asks nothing", async () => {
    const { user, picks } = await openMenu();
    await waitFor(() => expect(shown(picks).checked).toBe("false"));

    await user.click(picks);
    expect(shown(picks)).toEqual({ checked: "true", disabled: false, line: explained });
    expect(server.saves.map((save) => save.optedIn)).toEqual([true]);

    await user.click(picks);
    expect(server.saves).toHaveLength(1);

    server.saves[0]?.resolve();
    await waitFor(() => expect(server.optedIn).toBe(true));
    expect(shown(picks).checked).toBe("true");

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Account menu for ada" }));
    const reopened = await screen.findByRole("menuitemcheckbox", { name: "monthly picks" });
    expect(shown(reopened).checked).toBe("true");
    expect(server.reads).toBe(1);
  });

  test("moves back and says so when the save fails, and a second try can still save", async () => {
    const { user, picks } = await openMenu();
    await waitFor(() => expect(shown(picks).checked).toBe("false"));

    await user.click(picks);
    expect(shown(picks).checked).toBe("true");
    server.saves[0]?.reject();
    await waitFor(() =>
      expect(shown(picks)).toEqual({ checked: "false", disabled: false, line: "couldn't save that. try again" }),
    );

    await user.click(picks);
    server.saves[1]?.resolve();
    await waitFor(() => expect(shown(picks)).toEqual({ checked: "true", disabled: false, line: explained }));
  });

  test("a read that fails leaves the switch off and disabled, and the next open asks again", async () => {
    server.readFails = true;
    const { user, picks } = await openMenu();
    await waitFor(() =>
      expect(shown(picks)).toEqual({
        checked: "false",
        disabled: true,
        line: "couldn't load this. try again in a bit",
      }),
    );
    await user.click(picks);
    expect(server.saves).toEqual([]);

    server.readFails = false;
    server.optedIn = true;
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Account menu for ada" }));
    const reopened = await screen.findByRole("menuitemcheckbox", { name: "monthly picks" });
    await waitFor(() => expect(shown(reopened)).toEqual({ checked: "true", disabled: false, line: explained }));
    expect(server.reads).toBe(2);
  });
});
