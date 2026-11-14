import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { highlight, type Match, type Result, ResultItem } from "../src/index.ts";

const marked = (text: string, matches: Match[]) => {
  const { container } = render(<p>{highlight(text, matches)}</p>);
  const paragraph = container.querySelector("p");
  return {
    marks: [...container.querySelectorAll("mark")].map((mark) => mark.textContent),
    text: paragraph?.textContent,
    html: paragraph?.innerHTML,
  };
};

describe("matched words", () => {
  const reason = "Widgets for charts, gauges, sparklines, and tables.";

  test("each match becomes one mark around exactly the matched words", () => {
    const { marks, text, html } = marked(reason, [
      [12, 18],
      [20, 26],
    ]);
    expect(marks).toEqual(["charts", "gauges"]);
    expect(text).toBe(reason);
    expect(html).toBe("Widgets for <mark>charts</mark>, <mark>gauges</mark>, sparklines, and tables.");
  });

  test("matches are placed in reading order whatever order they arrive in", () => {
    expect(
      marked(reason, [
        [28, 38],
        [12, 18],
      ]).marks,
    ).toEqual(["charts", "sparklines"]);
  });

  test("overlapping matches never nest or repeat text", () => {
    const { marks, text } = marked(reason, [
      [12, 20],
      [16, 26],
    ]);
    expect(marks).toEqual(["charts, ", "gauges"]);
    expect(text).toBe(reason);
  });

  test("ranges outside the text are clipped and empty ranges are dropped", () => {
    const { marks, text } = marked("tui-rs", [
      [-4, 3],
      [5, 99],
      [2, 2],
    ]);
    expect(marks).toEqual(["tui", "s"]);
    expect(text).toBe("tui-rs");
  });

  test("a result tile puts its marks inside the reason paragraph", () => {
    const result: Result = {
      owner: "ClementTsang",
      name: "bottom",
      href: "?repo=ClementTsang/bottom",
      reason: "A system monitor dashboard for the terminal, built on ratatui.",
      matches: [
        [17, 26],
        [35, 43],
      ],
      activity: { state: "alive", label: "pushed last week" },
      stars: 11_600,
      starred: "Aug 2, 2025",
      network: [],
      visual: { kind: "monogram", letters: "cl" },
      language: "Rust",
      unread: false,
    };
    const { container } = render(<ResultItem result={result} />);
    const marks = [...container.querySelectorAll("article p mark")].map((mark) => mark.textContent);
    expect(marks).toEqual(["dashboard", "terminal"]);
    expect(container.querySelectorAll("mark")).toHaveLength(2);
    expect(container.querySelector("h3 a")?.getAttribute("href")).toBe("?repo=ClementTsang/bottom");
  });

  test("a result tile shows no star count until the repo has one", () => {
    const result: Result = {
      owner: "ratatui",
      name: "ratatui",
      href: "?repo=ratatui/ratatui",
      reason: "Widgets for terminal dashboards.",
      matches: [],
      activity: { state: "quiet", label: "no pushes yet" },
      stars: null,
      starred: "Mar 14, 2025",
      network: [],
      visual: { kind: "monogram", letters: "ra" },
      language: "Rust",
      unread: false,
    };
    const { container } = render(<ResultItem result={result} />);
    const terms = [...container.querySelectorAll("dt")].map((term) => term.textContent);
    expect(terms).not.toContain("stars");
    expect(terms).toContain("starred");
  });
});
