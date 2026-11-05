import { describe, expect, test } from "bun:test";
import * as expression from "blobatar/expression";
import { distanceInsideStar, fitEyes } from "../scripts/bake-pip.ts";

const poses = Object.entries(expression).filter(
  (entry): entry is [string, expression.Expression] =>
    typeof entry[1] === "object" && entry[1] !== null && "p" in entry[1],
);

type Eye = ReturnType<typeof fitEyes>[number];

const outline = ({ cx, cy, rx, ry, n, rot }: Eye) => {
  const turn = (rot * Math.PI) / 180;
  return Array.from({ length: 144 }, (_, index) => {
    const angle = (index * Math.PI) / 72;
    const curve = (value: number) => Math.sign(value) * Math.abs(value) ** (2 / n);
    const x = rx * curve(Math.cos(angle));
    const y = ry * curve(Math.sin(angle));
    return [cx + x * Math.cos(turn) - y * Math.sin(turn), cy + x * Math.sin(turn) + y * Math.cos(turn)] as const;
  });
};

describe("pip's eyes", () => {
  test("every blobatar pose exists to check", () => {
    expect(poses.length).toBeGreaterThanOrEqual(14);
  });

  for (const size of [40, 200])
    test(`stay inside the star in every pose at ${size}px`, () => {
      const margins = poses.map(([name, pose]) => {
        const eyes = pose.bake({ eyes: fitEyes(size) }, pose.p).l.eyes;
        const margin = Math.min(...eyes.flatMap(outline).map(([x, y]) => distanceInsideStar(x, y)));
        return { name, margin };
      });
      const worst = margins.toSorted((a, b) => a.margin - b.margin)[0];
      expect(worst?.margin).toBeGreaterThan(2);
    });
});
