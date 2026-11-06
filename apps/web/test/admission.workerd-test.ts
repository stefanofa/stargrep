import { env } from "cloudflare:workers";
import { Caller } from "@stargrep/api/caller";
import { OwnerLookup, SyncQueue } from "@stargrep/core/stars";
import type { Login } from "@stargrep/github/schemas";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { layerSyncQueue } from "../src/server/adapters.ts";
import { layerCaller } from "../src/server/caller.ts";
import { layerOwnerLookup } from "../src/server/owner-lookup.ts";

const lookup = (login: string) =>
  Effect.runPromise(
    OwnerLookup.OwnerLookup.use((owners) => owners.lookup(login as Login)).pipe(
      Effect.match({ onFailure: (failed) => ({ failed }), onSuccess: (found) => ({ found }) }),
      Effect.provide(layerOwnerLookup(env.WORKER)),
    ),
  );

describe("owner lookup over the main Worker's RPC method", () => {
  it("decodes a found user and an org", async () => {
    expect(await lookup("octocat")).toMatchObject({
      found: { _tag: "Some", value: { account: { login: "octocat", type: "user", followers: 1 }, starredTotal: 42 } },
    });
    expect(await lookup("an-org")).toMatchObject({
      found: { _tag: "Some", value: { account: { type: "org", followers: null }, starredTotal: 0 } },
    });
  });

  it("answers none for a login GitHub does not have", async () => {
    expect(await lookup("ghost-login")).toMatchObject({ found: { _tag: "None" } });
  });

  it("fails a spent budget and a GitHub failure as a failed lookup with its reason", async () => {
    expect(await lookup("budget-spent")).toMatchObject({ failed: { _tag: "OwnerLookupFailed", reason: "budget" } });
    expect(await lookup("github-down")).toMatchObject({ failed: { _tag: "OwnerLookupFailed", reason: "github" } });
  });

  it("fails a malformed reply and an RPC error envelope as an invalid reply", async () => {
    expect(await lookup("malformed")).toMatchObject({ failed: { _tag: "OwnerLookupFailed", reason: "reply-invalid" } });
    expect(await lookup("envelope")).toMatchObject({ failed: { _tag: "OwnerLookupFailed", reason: "reply-invalid" } });
  });
});

describe("the sync queue adapter", () => {
  it("sends a waiting sync with its delay rounded up to whole seconds, and a ready one with none", async () => {
    const sent: Array<{ readonly body: unknown; readonly options: QueueSendOptions | undefined }> = [];
    const queue = {
      send: async (body: unknown, options?: QueueSendOptions) => {
        sent.push({ body, options });
      },
    } as unknown as Queue<unknown>;
    const requestedAt = DateTime.makeUnsafe("2026-11-06T09:00:00Z");
    const send = (delay: Duration.Duration) =>
      SyncQueue.SyncQueue.use((sync) =>
        sync.send({ login: "octocat" as Login, mode: "incremental", requestedAt }, delay),
      );
    await Effect.runPromise(
      Effect.all([send(Duration.millis(90_200)), send(Duration.zero)]).pipe(Effect.provide(layerSyncQueue(queue))),
    );
    const body = { login: "octocat", mode: "incremental", requestedAt: DateTime.toEpochMillis(requestedAt) };
    expect(sent).toEqual([
      { body, options: { delaySeconds: 91 } },
      { body, options: { delaySeconds: 0 } },
    ]);
  });
});

describe("the caller key", () => {
  const keyFor = (ip: string, secret = "test-caller-key") =>
    Effect.runPromise(
      Effect.map(Caller, (caller) => caller.key).pipe(
        Effect.provide(
          layerCaller(secret, new Request("https://stargrep.test/", { headers: { "cf-connecting-ip": ip } })),
        ),
      ),
    );

  it("keys one network the same every time, under a secret, without naming its address", async () => {
    const key = await keyFor("192.0.2.1");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(await keyFor("192.0.2.1")).toBe(key);
    expect(await keyFor("::ffff:192.0.2.1")).toBe(key);
    expect(await keyFor("192.0.2.2")).not.toBe(key);
    expect(await keyFor("192.0.2.1", "another-stage")).not.toBe(key);
    expect(await keyFor("2001:db8:85a3::1")).toBe(await keyFor("2001:db8:85a3:0:ffff::2"));
  });
});
