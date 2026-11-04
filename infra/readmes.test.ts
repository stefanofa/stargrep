import { describe, expect, test } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Readmes } from "@stargrep/worker/readmes";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

const declare = (stage: string) =>
  Effect.runSync(
    Readmes.pipe(
      Effect.provideService(Alchemy.Stack, { name: "Stargrep", stage, resources: {}, bindings: {} } as never),
      Effect.provideService(Cloudflare.Providers, {} as never),
    ),
  );

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
