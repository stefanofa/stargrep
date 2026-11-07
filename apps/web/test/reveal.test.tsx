import "./register.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useReveal } from "../src/lib/reveal.ts";
import { revealedKey, revealScript } from "../src/lib/reveal-script.ts";

const root = () => document.documentElement;

afterEach(() => {
  cleanup();
  delete root().dataset.reveal;
  sessionStorage.clear();
});

describe("the staged reveal", () => {
  test("types once, settles, and reaches done without an interaction", async () => {
    root().dataset.reveal = "pending";
    const { result } = renderHook(() => useReveal("rust tui", true));
    expect(sessionStorage.getItem(revealedKey)).toBe("1");
    expect(result.current.typed).toBe("");
    expect(result.current.phase).toBe("typing");
    await waitFor(() => expect(result.current.phase).toBe("settled"));
    expect(result.current.typed).toBeUndefined();
    expect(root().dataset.reveal).toBeUndefined();
    await waitFor(() => expect(result.current.phase).toBe("done"));
  });

  test.each([
    ["a key", () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
    ["a click", () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))],
    ["a focus", () => document.body.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))],
  ])("%s anywhere on the page jumps to the end", async (_, interact) => {
    root().dataset.reveal = "pending";
    const { result } = renderHook(() => useReveal("rust tui library", true));
    expect(result.current.phase).toBe("typing");
    act(interact);
    expect(result.current.phase).toBe("done");
    expect(result.current.typed).toBeUndefined();
    expect(root().dataset.reveal).toBeUndefined();
  });

  test("plays nothing when the visitor is already in a field, typing", () => {
    root().dataset.reveal = "pending";
    const input = document.body.appendChild(document.createElement("input"));
    input.focus();
    try {
      const { result } = renderHook(() => useReveal("rust tui", true));
      expect(result.current.phase).toBe("done");
      expect(root().dataset.reveal).toBeUndefined();
    } finally {
      input.remove();
    }
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

describe("the reveal script before the engine hydrates", () => {
  const run = () => new Function(revealScript)();

  test("marks a first visit and hides the query until the first interaction", () => {
    run();
    expect(root().dataset.reveal).toBe("pending");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    expect(root().dataset.reveal).toBeUndefined();
  });

  test.each(["pointerdown", "focusin", "input"])("a %s anywhere on the page cancels the reveal", (name) => {
    run();
    document.body.dispatchEvent(new Event(name, { bubbles: true }));
    expect(root().dataset.reveal).toBeUndefined();
  });

  test("does nothing on a repeat visit", () => {
    sessionStorage.setItem(revealedKey, "1");
    run();
    expect(root().dataset.reveal).toBeUndefined();
  });

  test("text typed before hydration stays, and the reveal never starts", async () => {
    run();
    const input = document.body.appendChild(document.createElement("input"));
    try {
      input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      input.value = "terminal recorder";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const { result } = renderHook(() => useReveal("let an ai agent control my iphone", true));
      expect(result.current.phase).toBe("done");
      expect(result.current.typed).toBeUndefined();
      expect(input.value).toBe("terminal recorder");
    } finally {
      input.remove();
    }
  });
});
