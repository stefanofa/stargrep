import { describe, expect, test } from "bun:test";
import { distanceInsideStar, expressions, fitEyes, type Mark } from "../scripts/bake-pip.ts";

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
  for (const mark of ["small", "large"] satisfies ReadonlyArray<Mark>)
    test(`stay inside the ${mark} star in each of pip's poses, as blobatar's bake places them`, () => {
      const margins = Object.entries(expressions).map(([name, pose]) => {
        const eyes = pose.bake({ eyes: fitEyes(mark) }, pose.p).l.eyes;
        const margin = Math.min(...eyes.flatMap(outline).map(([x, y]) => distanceInsideStar(x, y)));
        return { name, margin };
      });
      const worst = margins.toSorted((a, b) => a.margin - b.margin)[0];
      expect(worst?.margin).toBeGreaterThan(2);
    });
});
