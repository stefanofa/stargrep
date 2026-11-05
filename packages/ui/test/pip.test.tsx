import "./register.ts";
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { act, render } from "@testing-library/react";
import { bakePip } from "../scripts/bake-pip.ts";
import { Pip, type PipPose, pipPoses } from "../src/index.ts";
import { pip } from "../src/mark/pip.gen.ts";

const draw = (pose: PipPose, size = 40) => {
  const svg = render(<Pip pose={pose} size={size} />).container.querySelector("svg");
  if (!svg) throw new Error(`no svg for ${pose}`);
  return svg;
};

describe("pip", () => {
  test("the installed blobatar still bakes the committed mark", () => {
    expect(bakePip()).toEqual(JSON.parse(JSON.stringify(pip)));
  });

  test("the mark renders the same markup the golden file holds", () => {
    expect(draw("idle").outerHTML).toMatchSnapshot("idle at 40");
    expect(draw("idle", 150).outerHTML).toMatchSnapshot("idle at 150");
  });

  test("a pose changes only the root's variables, so motion.css can morph between poses", () => {
    const inner = pipPoses.map((pose) => draw(pose).querySelector(".mo-root")?.innerHTML);
    expect(new Set(inner).size).toBe(1);
    const styles = pipPoses.map((pose) => draw(pose).querySelector(".mo-root")?.getAttribute("style"));
    expect(new Set(styles).size).toBe(pipPoses.length);
  });

  test("the mark is decoration and names its pose", () => {
    for (const pose of pipPoses) {
      const svg = draw(pose);
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.dataset.pose).toBe(pose);
    }
  });

  test("marks at 48px and under draw the larger eyes", () => {
    const eye = (size: number) => draw("idle", size).querySelector(".mo-eye path")?.getAttribute("d");
    expect(eye(30)).toBe(pip.eyes.small[0].d);
    expect(eye(48)).toBe(pip.eyes.small[0].d);
    expect(eye(49)).toBe(pip.eyes.large[0].d);
    expect(pip.eyes.small[0].d).not.toBe(pip.eyes.large[0].d);
  });

  test("the header mark keeps still until hovered, and a large mark keeps its ambient life", () => {
    const header = draw("idle", 40).querySelector(".mo-root");
    expect(header?.classList.contains("mo-always")).toBe(false);
    expect(header?.className).toContain("[&:not(:hover)]:[animation-play-state:paused]!");
    expect(draw("idle", 150).querySelector(".mo-root")?.classList.contains("mo-always")).toBe(true);
  });

  test("a large mark rests while it is offscreen and wakes when it scrolls back", () => {
    let report: (visible: boolean) => void = () => {};
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      readonly callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }
      observe() {
        report = (visible) =>
          this.callback(
            [{ isIntersecting: visible } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
      }
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    try {
      const root = draw("idle", 150).querySelector(".mo-root");
      expect(root?.classList.contains("[animation-play-state:paused]!")).toBe(false);
      act(() => report(false));
      expect(root?.classList.contains("[animation-play-state:paused]!")).toBe(true);
      act(() => report(true));
      expect(root?.classList.contains("[animation-play-state:paused]!")).toBe(false);
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });
});
