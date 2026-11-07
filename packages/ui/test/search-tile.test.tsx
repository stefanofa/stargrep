import "./register.ts";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { SearchTile, StatusLine } from "../src/index.ts";
import { page } from "./dom.ts";

function Harness() {
  const [query, setQuery] = useState("");
  return <SearchTile query={query} onQueryChange={setQuery} />;
}

describe("search input", () => {
  test("slash focuses the search input from anywhere on the page", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(document.activeElement).toBe(document.body);
    await user.keyboard("/");
    expect(document.activeElement).toBe(page().getByRole("searchbox"));
    expect(page().getByRole<HTMLInputElement>("searchbox").value).toBe("");
  });
});

describe("status line", () => {
  const label = () => page().getByRole("status").firstElementChild;

  test("on phones an action shares the line under the label with the detail", () => {
    const { container } = render(
      <StatusLine
        icon="failed"
        label="meaning search didn't answer"
        phoneLabel="meaning failed"
        detail="found 2"
        action={<button type="button">try again</button>}
      />,
    );
    const phone = container.cloneNode(true) as Element;
    for (const hidden of phone.querySelectorAll('[class~="max-sm:hidden"]')) hidden.remove();
    const desktop = container.cloneNode(true) as Element;
    for (const hidden of desktop.querySelectorAll('[class~="sm:hidden"]')) hidden.remove();
    expect(phone.textContent).toBe("meaning failedfound 2try again");
    expect(desktop.textContent).toBe("meaning search didn't answer · found 2try again");
  });

  test("a new sync state settles its label in, once", () => {
    const { rerender } = render(<StatusLine icon="busy" label="loading your stars" />);
    expect(label()?.className).not.toContain("animate-settle");
    rerender(<StatusLine icon="synced" label="24 stars" />);
    expect(label()?.className).toContain("animate-settle");
  });

  test("search answers swap in place while you type", () => {
    const { rerender } = render(<StatusLine icon="synced" label="24 stars" />);
    rerender(<StatusLine icon="busy" label="searching" instant />);
    rerender(<StatusLine icon="found" label="found 3" instant />);
    expect(label()?.textContent).toBe("found 3");
    expect(label()?.className).not.toContain("animate-settle");
  });
});

describe("a server-rendered tile", () => {
  test("keeps what was typed before its script arrived", async () => {
    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");
    const { act } = await import("@testing-library/react");
    const container = document.createElement("div");
    container.innerHTML = renderToString(<SearchTile query="terminal dashboard" />);
    document.body.append(container);
    const input = container.querySelector("input") as HTMLInputElement;
    input.value = "terminal recorder";
    const seen: Array<string> = [];
    await act(async () => {
      hydrateRoot(container, <SearchTile query="terminal dashboard" onQueryChange={(next) => seen.push(next)} />);
    });
    expect(seen).toEqual(["terminal recorder"]);
    container.remove();
  });
});
