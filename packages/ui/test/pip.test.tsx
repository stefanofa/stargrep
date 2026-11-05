import "./register.ts";
import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
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

  test("every pose renders the same markup the golden file holds", () => {
    for (const pose of pipPoses) {
      expect(draw(pose).outerHTML).toMatchSnapshot(`${pose} at 40`);
      expect(draw(pose, 150).outerHTML).toMatchSnapshot(`${pose} at 150`);
    }
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

  test("small marks get the larger eyes", () => {
    const eyes = (size: number) =>
      draw("idle", size).querySelector(".mo-eyes")?.parentElement?.getAttribute("transform");
    expect(eyes(30)).toContain("scale(1)");
    expect(eyes(48)).toContain("scale(1)");
    expect(eyes(150)).toContain("scale(0.82)");
  });
});
