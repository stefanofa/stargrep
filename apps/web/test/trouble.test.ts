import { describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import { libraryTrouble, refusalOf, rememberedRefusal, type Trouble, troubleCopy } from "../src/lib/trouble.ts";

const troubles: ReadonlyArray<Trouble> = ["missing", "busy", "limited", "unavailable", "load-limited", "load-failed"];

describe("what a stars page says when it can't show stars", () => {
  test("maps wire codes to one trouble each, and anything else to unavailable", () => {
    expect(refusalOf(new ORPCError("LOGIN_NOT_FOUND"))).toBe("missing");
    expect(refusalOf(new ORPCError("SYNC_BUSY"))).toBe("busy");
    expect(refusalOf(new ORPCError("TOO_MANY_REQUESTS"))).toBe("limited");
    expect(refusalOf(new ORPCError("SERVICE_UNAVAILABLE"))).toBe("unavailable");
    expect(refusalOf(new Error("offline"))).toBe("unavailable");
    expect(libraryTrouble(new ORPCError("TOO_MANY_REQUESTS"))).toBe("load-limited");
    expect(libraryTrouble(new Error("offline"))).toBe("load-failed");
  });

  test("never marks a refusal with a check, and one network limit reads the same wherever it hits", () => {
    for (const trouble of troubles) expect(troubleCopy(trouble, "octo", false).status.icon).not.toBe("done");
    expect(troubleCopy("busy", "octo", false).status.icon).toBe("paused");
    expect(troubleCopy("limited", "octo", false).status).toEqual(troubleCopy("load-limited", "octo", false).status);
    expect(troubleCopy("limited", "octo", false).heading).toBe(troubleCopy("load-limited", "octo", false).heading);
  });

  test("offers the right try again, and none for a login GitHub doesn't know", () => {
    expect(troubles.map((trouble) => troubleCopy(trouble, "octo", false).retry)).toEqual([
      null,
      "sync",
      "sync",
      "sync",
      "library",
      "library",
    ]);
  });

  test("says whose stars, and your stars on the viewer's own page", () => {
    expect(troubleCopy("load-failed", "octo", false).heading).toBe("stargrep couldn't load @octo's stars");
    expect(troubleCopy("load-failed", "juno", true).heading).toBe("stargrep couldn't load your stars");
    expect(troubleCopy("missing", "nobody-x", false).heading).toBe("github has no one called @nobody-x");
  });

  test("reads a remembered refusal for its own login only", () => {
    const cookies = `theme=dark; stargrep-refused=${encodeURIComponent("Nobody-X:missing")}; other=1`;
    expect(rememberedRefusal(cookies, "nobody-x")).toBe("missing");
    expect(rememberedRefusal(cookies, "someone-else")).toBeUndefined();
    expect(rememberedRefusal("stargrep-refused=nobody-x%3Aload-failed", "nobody-x")).toBeUndefined();
    expect(rememberedRefusal(null, "nobody-x")).toBeUndefined();
  });
});
