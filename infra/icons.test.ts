import { describe, expect, test } from "bun:test";
import { Icons } from "@stargrep/worker/icons";
import { inStage } from "./test-stage.ts";

describe("Icons bucket", () => {
  test("prod's bucket is retained, never emptied on destroy, and has no public domain", () => {
    const bucket = inStage("prod")(Icons);
    expect(bucket.LogicalId).toBe("Icons");
    expect(bucket.RemovalPolicy).toBe("retain");
    expect(bucket.Props).toBeUndefined();
  });

  test("a preview's bucket is emptied and deleted on destroy, with no public domain", () => {
    const bucket = inStage("pr-1")(Icons);
    expect(bucket.LogicalId).toBe("Icons");
    expect(bucket.RemovalPolicy).toBe("destroy");
    expect(bucket.Props).toEqual({ forceDestroy: true });
  });
});
