import "./register.ts";
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { Mascot, moods } from "../src/index.ts";

const draw = (mood: (typeof moods)[number]) => {
  const { container } = render(<Mascot mood={mood} />);
  const svg = container.querySelector("svg");
  if (!svg) throw new Error(`no svg for ${mood}`);
  return {
    svg,
    body: svg.querySelector('[data-part="body"]')?.outerHTML,
    face: svg.querySelector('[data-part="face"]')?.outerHTML,
  };
};

describe("mascot", () => {
  test("every mood keeps the same body and draws its own face", () => {
    const drawn = moods.map(draw);
    const [first] = drawn;
    for (const { body } of drawn) expect(body).toBe(first?.body);
    expect(new Set(drawn.map(({ face }) => face)).size).toBe(moods.length);
  });

  test("the mascot is hidden from assistive technology and names its mood", () => {
    for (const mood of moods) {
      const { svg } = draw(mood);
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.dataset.mood).toBe(mood);
    }
  });

  test("only the searching mood holds a magnifying glass", () => {
    const withGlass = moods.filter((mood) => draw(mood).svg.querySelectorAll("circle[r='10']").length > 0);
    expect(withGlass).toEqual(["searching"]);
  });

  test("the delighted mood closes both eyes", () => {
    const { svg } = draw("delighted");
    expect(svg.querySelectorAll('[data-part="face"] circle')).toHaveLength(0);
  });

  test("motion is opt in", () => {
    expect(draw("happy").svg.outerHTML).not.toContain("animate-");
    const { container } = render(<Mascot mood="happy" motion="blink" />);
    expect(container.querySelector(".animate-blink")).not.toBeNull();
  });
});
