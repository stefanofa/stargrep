import { describe, expect, test } from "bun:test";
import { createORPCErrorFromJson, ORPCError } from "@orpc/client";
import type { WireCode } from "@stargrep/api/errors";
import { libraryTrouble, refusalOf, rememberedRefusal } from "../src/lib/trouble.ts";
import { edgeAnswers } from "./edge-answers.ts";

// The API marks every error its contract defines.
const answered = (code: WireCode) => createORPCErrorFromJson({ defined: true, code, message: code, data: undefined });

describe("why a stars page can't show stars", () => {
  test("maps wire codes to one trouble each, and anything else to unavailable", () => {
    expect(refusalOf(answered("LOGIN_NOT_FOUND"))).toBe("missing");
    expect(refusalOf(answered("SYNC_BUSY"))).toBe("busy");
    expect(refusalOf(answered("TOO_MANY_REQUESTS"))).toBe("limited");
    expect(refusalOf(answered("SERVICE_UNAVAILABLE"))).toBe("unavailable");
    expect(refusalOf(new Error("offline"))).toBe("unavailable");
    expect(refusalOf(new ORPCError("TOO_MANY_REQUESTS"))).toBe("unavailable");
    expect(libraryTrouble(answered("TOO_MANY_REQUESTS"))).toBe("load-limited");
    expect(libraryTrouble(new Error("offline"))).toBe("load-failed");
  });

  test("a 429 page from the zone's rate limit is too many requests, and any other page from the edge is not", async () => {
    const failureFrom = (status: 429 | 502) =>
      edgeAnswers(status)
        .triggerSync({ login: "octocat" })
        .then(
          () => expect.unreachable(),
          (error: unknown) => error,
        );
    const blocked = await failureFrom(429);
    expect([refusalOf(blocked), libraryTrouble(blocked)]).toEqual(["limited", "load-limited"]);
    const down = await failureFrom(502);
    expect([refusalOf(down), libraryTrouble(down)]).toEqual(["unavailable", "load-failed"]);
  });

  test("reads a remembered refusal for its own login only", () => {
    const cookies = `theme=dark; stargrep-refused=${encodeURIComponent("Nobody-X:missing")}; other=1`;
    expect(rememberedRefusal(cookies, "nobody-x")).toBe("missing");
    expect(rememberedRefusal(cookies, "someone-else")).toBeUndefined();
    expect(rememberedRefusal("stargrep-refused=nobody-x%3Aload-failed", "nobody-x")).toBeUndefined();
    expect(rememberedRefusal(null, "nobody-x")).toBeUndefined();
  });
});
