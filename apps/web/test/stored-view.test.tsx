import "./register.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { type View, ViewToggle } from "@stargrep/ui";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { storedView, useStoredView } from "../src/lib/stored-view.ts";

function Toggle({ initial }: { initial: View }) {
  const [view, setView] = useStoredView(initial);
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
  // biome-ignore lint/suspicious/noDocumentCookie: the test clears the cookie the page writes.
  document.cookie = "stargrep-view=; Max-Age=0; Path=/";
});

describe("the stored view", () => {
  test("a picked view lands in the cookie the server reads for the next page", async () => {
    const user = userEvent.setup();
    render(<Toggle initial="tiles" />);
    expect(storedView(document.cookie)).toBeUndefined();
    await user.click(within(document.body).getByRole("button", { name: "List view" }));
    expect(pressed("List view")).toBe("true");
    expect(storedView(document.cookie)).toBe("list");
  });

  test("the server paints the view the cookie holds", () => {
    const html = renderToString(<Toggle initial={storedView("theme=dark; stargrep-view=list") ?? "tiles"} />);
    expect(html).toContain("view-list");
  });

  test("an unreadable cookie value is no view", () => {
    expect(storedView("stargrep-view=carousel")).toBeUndefined();
    expect(storedView("stargrep-view=%")).toBeUndefined();
    expect(storedView(null)).toBeUndefined();
  });
});
