import "./register.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useReveal } from "../src/lib/reveal.ts";
import { revealedKey } from "../src/lib/reveal-script.ts";

const root = () => document.documentElement;

afterEach(() => {
  cleanup();
  delete root().dataset.reveal;
  sessionStorage.clear();
});

describe("the staged reveal", () => {
  test("types the query once, settles, and marks the visit as revealed", async () => {
    root().dataset.reveal = "pending";
    const { result } = renderHook(() => useReveal("rust tui", true));
    expect(sessionStorage.getItem(revealedKey)).toBe("1");
    expect(result.current.typed).toBe("");
    await act(() => Bun.sleep(90));
    expect("rust tui".startsWith(result.current.typed ?? "x")).toBe(true);
    expect(result.current.typed?.length).toBeGreaterThan(0);
    await act(() => Bun.sleep(1400));
    expect(result.current.phase).toBe("done");
    expect(result.current.typed).toBeUndefined();
    expect(root().dataset.reveal).toBeUndefined();
  });

  test("any interaction jumps to the end", async () => {
    root().dataset.reveal = "pending";
    const { result } = renderHook(() => useReveal("rust tui library", true));
    await act(() => Bun.sleep(60));
    expect(result.current.typed?.length).toBeGreaterThan(0);
    act(() => result.current.skip());
    expect(result.current.phase).toBe("done");
    expect(result.current.typed).toBeUndefined();
    expect(root().dataset.reveal).toBeUndefined();
  });

  test("plays nothing on a page without a first answer, and clears the mark", () => {
    root().dataset.reveal = "pending";
    const { result } = renderHook(() => useReveal("rust tui", false));
    expect(result.current.phase).toBe("done");
    expect(root().dataset.reveal).toBeUndefined();
    expect(sessionStorage.getItem(revealedKey)).toBeNull();
  });

  test("plays nothing when the head script did not mark the page", () => {
    const { result } = renderHook(() => useReveal("rust tui", true));
    expect(result.current.phase).toBe("done");
    expect(result.current.typed).toBeUndefined();
  });

  test("plays nothing in a tab opened in the background, and shows the query", () => {
    root().dataset.reveal = "pending";
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      const { result } = renderHook(() => useReveal("rust tui", true));
      expect(result.current.phase).toBe("done");
      expect(result.current.typed).toBeUndefined();
      expect(root().dataset.reveal).toBeUndefined();
    } finally {
      if (visibility) Object.defineProperty(document, "visibilityState", visibility);
      else Reflect.deleteProperty(document, "visibilityState");
    }
  });
});
