import { describe, expect, test } from "bun:test";
import { cn } from "../src/lib/cn.ts";

describe("cn", () => {
  test("a later class from the custom theme scale replaces the earlier one", () => {
    expect(cn("text-sm leading-4", "text-label leading-[13px]")).toBe("text-label leading-[13px]");
    expect(cn("text-[14px] text-muted-foreground", "text-meta text-secondary-foreground")).toBe(
      "text-meta text-secondary-foreground",
    );
    expect(cn("size-tile border-2", "size-9 border-[2.5px]")).toBe("size-9 border-[2.5px]");
    expect(cn("rounded-sm", "rounded-md")).toBe("rounded-md");
  });

  test("a size and a color on the same prefix both stay", () => {
    expect(cn("text-label text-muted-foreground")).toBe("text-label text-muted-foreground");
    expect(cn("text-name text-foreground")).toBe("text-name text-foreground");
  });

  test("a side padding refines the tile padding instead of replacing it", () => {
    expect(cn("p-tile", "pt-tile-top")).toBe("p-tile pt-tile-top");
  });
});
