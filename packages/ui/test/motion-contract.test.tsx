import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { Pip, pipPoses } from "../src/index.ts";

const stylesheet = await Bun.file(Bun.resolveSync("blobatar/motion.css", import.meta.dir)).text();

const used = () => {
  const classes = new Set<string>();
  const properties = new Set<string>();
  for (const pose of pipPoses)
    for (const size of [30, 200]) {
      const { container, unmount } = render(<Pip pose={pose} size={size} />);
      for (const element of container.querySelectorAll("*")) {
        for (const name of element.classList) if (name.startsWith("mo-")) classes.add(name);
        for (const match of (element.getAttribute("style") ?? "").matchAll(/(--mo-[a-z0-9-]+)\s*:/g))
          if (match[1]) properties.add(match[1]);
      }
      unmount();
    }
  return { classes: [...classes].toSorted(), properties: [...properties].toSorted() };
};

describe("blobatar's motion.css still animates pip's markup", () => {
  const { classes, properties } = used();

  test("pip uses the class structure and variables it was built against", () => {
    expect(classes).toEqual([
      "mo-always",
      "mo-bob",
      "mo-breathe",
      "mo-expr",
      "mo-eye",
      "mo-eyes",
      "mo-root",
      "mo-slow",
    ]);
    expect(properties.length).toBeGreaterThan(20);
  });

  test("every class pip sets has a rule in motion.css", () => {
    expect(classes.filter((name) => !stylesheet.includes(`.${name}`))).toEqual([]);
  });

  test("every variable pip sets is read by motion.css", () => {
    expect(properties.filter((name) => !stylesheet.includes(`var(${name}`))).toEqual([]);
  });
});
