import "./register.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { ViewToggle } from "@stargrep/ui";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { useStoredView } from "../src/lib/stored-view.ts";

function Toggle() {
  const [view, setView] = useStoredView();
  return (
    <>
      <ViewToggle value={view} onValueChange={setView} />
      <p className={view === "list" ? "view-list" : "view-tiles"} />
    </>
  );
}

const pressed = (name: string) => within(document.body).getByRole("button", { name }).getAttribute("aria-pressed");

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("the stored view", () => {
  test("the chosen view survives a remount through local storage", async () => {
    const user = userEvent.setup();
    const first = render(<Toggle />);
    await user.click(within(document.body).getByRole("button", { name: "List view" }));
    expect(pressed("List view")).toBe("true");
    first.unmount();

    render(<Toggle />);
    expect(pressed("List view")).toBe("true");
    expect(pressed("Tiles view")).toBe("false");
  });

  test("server rendering never reads storage and renders the default view", () => {
    localStorage.setItem("stargrep:view", "list");
    const storage = globalThis.localStorage;
    let reads = 0;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        reads++;
        return storage;
      },
    });
    try {
      const html = renderToString(<Toggle />);
      expect(reads).toBe(0);
      expect(html).toContain("view-tiles");
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    }
  });

  test("an unreadable stored value falls back to tiles", () => {
    localStorage.setItem("stargrep:view", "carousel");
    render(<Toggle />);
    expect(pressed("Tiles view")).toBe("true");
  });
});
