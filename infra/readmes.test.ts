import { describe, expect, test } from "bun:test";
import { Readmes } from "@stargrep/worker/readmes";
import { inStage } from "./test-stage.ts";

const declare = (stage: string) => inStage(stage)(Readmes);

describe("Readmes bucket", () => {
  test("prod's bucket is retained and never emptied on destroy", () => {
    const bucket = declare("prod");
    expect(bucket.RemovalPolicy).toBe("retain");
    expect((bucket.Props as { forceDestroy?: boolean } | undefined)?.forceDestroy).not.toBe(true);
  });

  test("a preview's bucket is emptied and deleted on destroy", () => {
    const bucket = declare("pr-1");
    expect(bucket.RemovalPolicy).toBe("destroy");
    expect(bucket.Props).toEqual({ forceDestroy: true });
  });
});
