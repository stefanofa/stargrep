import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { captured } from "./posthog.fake.ts";

const { fewestStarsShown, SourceLink } = await import("../src/components/source-link.tsx");

const setHost = (url: string) =>
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url);

afterEach(() => {
  cleanup();
  setHost("http://localhost/");
  captured.length = 0;
});

const link = () => screen.getByRole("link", { name: /^source/ });

describe("the footer's source link", () => {
  test("opens Stargrep's repo in a new tab, with the count the server read", () => {
    render(<SourceLink stars={1234} />);
    expect(link().getAttribute("href")).toBe("https://github.com/stefanofa/stargrep");
    expect(link().getAttribute("target")).toBe("_blank");
    expect(link().getAttribute("rel")).toBe("noopener");
    expect(link().textContent).toBe("source ★ 1.2k stars");
  });

  test("a count shows from 10 stars, and fewer render as no count at all", () => {
    expect(fewestStarsShown).toBe(10);
    const { rerender } = render(<SourceLink stars={9} />);
    expect(link().textContent).toBe("source ★");
    rerender(<SourceLink stars={0} />);
    expect(link().textContent).toBe("source ★");
    rerender(<SourceLink stars={10} />);
    expect(link().textContent).toBe("source ★ 10 stars");
  });

  test("without a count it shows the word and the star, and nothing waits for a number", () => {
    render(<SourceLink stars={null} />);
    expect(link().textContent).toBe("source ★");
  });

  test("a click on prod captures github_star_clicked", async () => {
    setHost("https://stargrep.com/");
    render(<SourceLink stars={5} />);
    link().addEventListener("click", (event) => event.preventDefault());
    await userEvent.setup().click(link());
    await waitFor(() => expect(captured).toEqual([["github_star_clicked", undefined]]));
  });

  test("a click anywhere but prod sends nothing", async () => {
    render(<SourceLink stars={5} />);
    link().addEventListener("click", (event) => event.preventDefault());
    await userEvent.setup().click(link());
    expect(captured).toEqual([]);
  });
});
