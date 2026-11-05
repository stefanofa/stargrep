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
});
