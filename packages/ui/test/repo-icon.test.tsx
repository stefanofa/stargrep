import "./dom.ts";
import { describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { RepoIcon, type RepoVisual } from "../src/index.ts";

const icon = (size: number, plate: "none" | "light" | "dark" = "none"): RepoVisual => ({
  kind: "icon",
  url: "https://icons.example/icon.webp",
  plate,
  size,
  letters: "ra",
});

const draw = (visual: RepoVisual) => {
  const { container } = render(<RepoIcon visual={visual} />);
  const slot = container.firstElementChild as HTMLElement;
  return { slot, image: slot.querySelector("img") };
};

describe("the repo icon slot", () => {
  test("a full size icon fills the slot on its plate", () => {
    const { slot, image } = draw(icon(128, "dark"));
    expect(slot.className).toContain("bg-ink");
    expect(image?.className).toContain("size-full");
    expect(image?.style.width).toBe("");
  });

  test("a source under 64px keeps its own size on a muted tile, never upscaled", () => {
    const { slot, image } = draw(icon(16));
    expect(slot.className).toContain("bg-muted");
    expect(image?.style.width).toBe("16px");
    expect(image?.getAttribute("width")).toBe("16");
  });

  test("a small source larger than 24px shows at 24px", () => {
    expect(draw(icon(48)).image?.style.width).toBe("24px");
  });

  test("a 64px source counts as full size", () => {
    expect(draw(icon(64)).image?.className).toContain("size-full");
  });

  test("an image that fails to load becomes the monogram", () => {
    const { container } = render(<RepoIcon visual={icon(128)} />);
    const image = container.querySelector("img");
    if (image === null) throw new Error("no image");
    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("ra");
  });

  test("a monogram needs no image", () => {
    const { container } = render(<RepoIcon visual={{ kind: "monogram", letters: "cl" }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("cl");
  });
});
