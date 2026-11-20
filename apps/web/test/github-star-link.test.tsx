import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// PostHog itself, as the browser would load it on prod.
const captured: Array<string> = [];
const posthog = {
  init: () => {},
  register: () => {},
  capture: (event: string) => void captured.push(event),
  captureException: () => {},
};
mock.module("posthog-js/dist/module.no-external", () => ({ posthog }));
const { fewestStarsShown, GitHubStarLink } = await import("../src/components/github-star-link.tsx");

const setHost = (url: string) =>
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url);

afterEach(() => {
  cleanup();
  setHost("http://localhost/");
  captured.length = 0;
});

const link = () => screen.getByRole("link", { name: "star stargrep on GitHub" });

describe("the header's star on github link", () => {
  test("opens Stargrep's repo in a new tab, with the count the server read", () => {
    render(<GitHubStarLink stars={1234} />);
    expect(link().getAttribute("href")).toBe("https://github.com/stefanofa/stargrep");
    expect(link().getAttribute("target")).toBe("_blank");
    expect(link().getAttribute("rel")).toBe("noopener");
    expect(link().textContent).toBe("star1.2k");
  });

  test("a count shows from 10 stars, and fewer render as no count at all", () => {
    expect(fewestStarsShown).toBe(10);
    const { rerender } = render(<GitHubStarLink stars={9} />);
    expect(link().textContent).toBe("star");
    expect(link().querySelectorAll("span")).toHaveLength(1);
    rerender(<GitHubStarLink stars={0} />);
    expect(link().textContent).toBe("star");
    rerender(<GitHubStarLink stars={10} />);
    expect(link().textContent).toBe("star10");
  });

  test("without a count it shows the mark and the word, and nothing waits for a number", () => {
    render(<GitHubStarLink stars={null} />);
    expect(link().textContent).toBe("star");
    expect(link().querySelectorAll("span")).toHaveLength(1);
  });

  test("a click on prod captures github_star_clicked", async () => {
    setHost("https://stargrep.com/");
    render(<GitHubStarLink stars={5} />);
    link().addEventListener("click", (event) => event.preventDefault());
    await userEvent.setup().click(link());
    await waitFor(() => expect(captured).toEqual(["github_star_clicked"]));
  });

  test("a click anywhere but prod sends nothing", async () => {
    render(<GitHubStarLink stars={5} />);
    link().addEventListener("click", (event) => event.preventDefault());
    await userEvent.setup().click(link());
    expect(captured).toEqual([]);
  });
});
