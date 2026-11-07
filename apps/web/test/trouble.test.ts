import { describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import { libraryTrouble, refusalOf, rememberedRefusal } from "../src/lib/trouble.ts";

describe("why a stars page can't show stars", () => {
  test("maps wire codes to one trouble each, and anything else to unavailable", () => {
    expect(refusalOf(new ORPCError("LOGIN_NOT_FOUND"))).toBe("missing");
    expect(refusalOf(new ORPCError("SYNC_BUSY"))).toBe("busy");
    expect(refusalOf(new ORPCError("TOO_MANY_REQUESTS"))).toBe("limited");
    expect(refusalOf(new ORPCError("SERVICE_UNAVAILABLE"))).toBe("unavailable");
    expect(refusalOf(new Error("offline"))).toBe("unavailable");
    expect(libraryTrouble(new ORPCError("TOO_MANY_REQUESTS"))).toBe("load-limited");
    expect(libraryTrouble(new Error("offline"))).toBe("load-failed");
  });

  test("reads a remembered refusal for its own login only", () => {
    const cookies = `theme=dark; stargrep-refused=${encodeURIComponent("Nobody-X:missing")}; other=1`;
    expect(rememberedRefusal(cookies, "nobody-x")).toBe("missing");
    expect(rememberedRefusal(cookies, "someone-else")).toBeUndefined();
    expect(rememberedRefusal("stargrep-refused=nobody-x%3Aload-failed", "nobody-x")).toBeUndefined();
    expect(rememberedRefusal(null, "nobody-x")).toBeUndefined();
  });
});
