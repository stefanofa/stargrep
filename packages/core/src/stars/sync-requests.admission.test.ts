import { expect } from "bun:test";
import type { Login } from "@stargrep/github/schemas";
import { collectSpans } from "@stargrep/telemetry/collector";
import * as it from "@stargrep/testing";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as OwnerLookup from "./owner-lookup.ts";
import {
  admitted,
  admitting,
  anyone,
  at,
  brokenQueue,
  claimInFlight,
  fill,
  fullSynced,
  lineUnits,
  markFailed,
  memory,
  minute,
  octocat,
  org,
  owner,
  ownerId,
  request,
  row,
  signedUp,
  start,
  status,
  synced,
  unitMillis,
  units,
} from "./sync-requests.fixture.ts";
import * as SyncRequests from "./sync-requests.ts";

it.layer(memory, { timeout: 30_000 })("SyncRequests admission", (it) => {
  it.effect("queues an unknown login once and reports it done after a later sync", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        expect(yield* status("octocat")).toEqual({ state: "unknown", starredTotal: null, accountType: null });
        expect(yield* request("octocat")).toEqual({
          state: "queued",
          requestedAt: at(start),
          syncedAt: null,
          ...octocat,
        });
        yield* TestClock.adjust("1 minute");
        expect(yield* request("OctoCat")).toEqual({
          state: "queued",
          requestedAt: at(start),
          syncedAt: null,
          ...octocat,
        });
        expect(sent).toEqual([{ login: "octocat" as Login, mode: "incremental", requestedAt: at(start), reserved: 4 }]);

        yield* synced("octocat", start + 30_000);
        expect(yield* status("Octocat")).toEqual({ state: "done", syncedAt: at(start + 30_000), ...octocat });
      }),
    ),
  );

  it.effect("sends again once the cooldown passes and the earlier request never finished", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* request("octocat");
        yield* TestClock.adjust("11 minutes");
        expect(yield* request("octocat")).toEqual({
          state: "queued",
          requestedAt: at(start + 11 * minute),
          syncedAt: null,
          ...octocat,
        });
        expect(sent).toHaveLength(2);
      }),
    ),
  );

  it.effect("answers a login synced inside the cooldown without sending, and syncs it again after", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* synced("octocat", start - 5 * minute);
        expect(yield* request("octocat")).toEqual({ state: "done", syncedAt: at(start - 5 * minute), ...signedUp });
        expect(sent).toEqual([]);

        yield* TestClock.adjust("6 minutes");
        expect(yield* request("octocat")).toEqual({
          state: "queued",
          requestedAt: at(start + 6 * minute),
          syncedAt: at(start - 5 * minute),
          ...octocat,
        });
        expect(sent).toHaveLength(1);
      }),
    ),
  );

  it.effect("reports a dead-lettered request as failed and queues it again only after the cooldown", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* request("hubot");
        yield* TestClock.adjust("1 minute");
        yield* markFailed("HuBot", start);
        const failed = { state: "failed", requestedAt: at(start), syncedAt: null, ...octocat } as const;
        expect(yield* status("hubot")).toEqual(failed);
        expect(yield* request("hubot")).toEqual(failed);
        expect(sent).toHaveLength(1);

        yield* TestClock.adjust("10 minutes");
        expect(yield* request("hubot")).toMatchObject({ state: "queued" });
        expect(sent).toHaveLength(2);
      }),
    ),
  );

  it.effect("keeps a fresh request queued when the dead letter of an older one arrives", () =>
    admitting(() =>
      Effect.gen(function* () {
        yield* request("octocat");
        yield* TestClock.adjust("11 minutes");
        const fresh = yield* request("octocat");
        yield* markFailed("octocat", start);
        expect(yield* status("octocat")).toEqual(fresh);
        expect(fresh).toMatchObject({ state: "queued", requestedAt: at(start + 11 * minute) });
      }),
    ),
  );

  it.effect("never sends a full sync for anyone", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* synced("octocat", start - 60 * minute);
        yield* request("octocat");
        expect(sent.map((each) => each.mode)).toEqual(["incremental"]);
      }),
    ),
  );

  it.effect("forgets a request after a day", () =>
    admitting(() =>
      Effect.gen(function* () {
        yield* request("octocat");
        yield* TestClock.adjust("25 hours");
        expect(yield* status("octocat")).toEqual({ state: "unknown", ...octocat });
      }),
    ),
  );

  it.effect("answers a login GitHub does not have as not found, from the claim row for 10 minutes", () =>
    admitting(({ sent, lookups }) =>
      Effect.gen(function* () {
        for (const _ of [1, 2]) {
          expect(yield* Effect.flip(request("no-such-login"))).toMatchObject({
            _tag: "LoginNotFound",
            login: "no-such-login",
          });
        }
        expect(lookups).toEqual(["no-such-login" as Login]);
        expect(sent).toEqual([]);
        expect(yield* status("no-such-login")).toEqual({ state: "unknown", starredTotal: null, accountType: null });
        expect(yield* row("no-such-login")).toMatchObject(Option.some({ outcome: "missing", startsAt: null }));

        yield* TestClock.adjust("9 minutes");
        expect((yield* Effect.flip(request("no-such-login")))._tag).toBe("LoginNotFound");
        expect(lookups).toHaveLength(1);
        yield* TestClock.adjust("1 minute");
        expect((yield* Effect.flip(request("no-such-login")))._tag).toBe("LoginNotFound");
        expect(lookups).toHaveLength(2);
      }),
    ),
  );

  it.effect("keeps serving a synced login that GitHub no longer has, and answers its triggers not found", () =>
    admitting(({ owners }) =>
      Effect.gen(function* () {
        yield* synced("octocat", start - 60 * minute);
        owners.delete("octocat");
        expect((yield* Effect.flip(request("octocat")))._tag).toBe("LoginNotFound");
        expect(yield* status("octocat")).toEqual({ state: "done", syncedAt: at(start - 60 * minute), ...signedUp });
      }),
    ),
  );

  it.effect("answers an org done with a starred total of 0, sends nothing, and pays only its lookup", () =>
    admitting(({ sent, owners }) =>
      Effect.gen(function* () {
        owners.set("github", org("github", 9919));
        const done = { state: "done", syncedAt: at(start), starredTotal: 0, accountType: "org" } as const;
        expect(yield* request("github")).toEqual(done);
        expect(sent).toEqual([]);
        expect(yield* lineUnits()).toBe(1);
        expect(yield* status("GitHub")).toEqual(done);
        expect(yield* row("github")).toMatchObject(Option.some({ outcome: "pending", startsAt: at(start) }));
      }),
    ),
  );

  it.effect("claims nothing on a failed lookup, and fails a spent GitHub budget as busy", () =>
    Effect.gen(function* () {
      const failing = (reason: OwnerLookup.OwnerLookupFailed["reason"]) =>
        admitting(() => Effect.flip(request("octocat")), {
          hooks: { duringLookup: () => Effect.fail(new OwnerLookup.OwnerLookupFailed({ reason })) },
        });
      expect(yield* failing("timeout")).toMatchObject({ _tag: "OwnerLookupFailed", reason: "timeout" });
      expect(yield* row("octocat")).toEqual(Option.none());
      expect(yield* failing("budget")).toMatchObject({ _tag: "SyncBusy", reason: "github-budget" });
      expect(yield* row("octocat")).toEqual(Option.none());
      expect(yield* lineUnits()).toBe(0);
    }),
  );

  it.effect("counts each decision and marks the span with no login or caller in any attribute", () =>
    admitting(() =>
      Effect.gen(function* () {
        const [started, notFound] = [yield* admitted("started"), yield* admitted("not-found")];
        const collected = collectSpans();
        yield* request("octocat").pipe(Effect.withTracer(collected.tracer));
        yield* request("no-such-login").pipe(Effect.ignore, Effect.withTracer(collected.tracer));
        expect(yield* admitted("started")).toBe(started + 1);
        expect(yield* admitted("not-found")).toBe(notFound + 1);
        const span = collected.named("SyncRequests.request");
        expect(span?.attributes.get("sync.admission.decision")).toBe("started");
        expect(span?.attributes.get("sync.admission.cost")).toBe(5);
        expect(span?.attributes.get("sync.admission.wait_seconds")).toBe(0);
        const attributes = collected.spans.flatMap((each) => [...each.attributes.values()].map(String));
        expect(attributes.join(" ")).not.toMatch(/octocat|no-such-login|caller-a/);
      }),
    ),
  );
});

it.layer(memory, { timeout: 30_000 })("SyncRequests for the owner", (it) => {
  it.effect("queues the owner's library open a minute after a sync that anyone has to wait 10 minutes for", () =>
    admitting(({ sent, lookups }) =>
      Effect.gen(function* () {
        yield* synced("octocat", start - 2 * minute);
        yield* fullSynced(start - 2 * minute);
        expect(yield* request("octocat")).toEqual({ state: "done", syncedAt: at(start - 2 * minute), ...signedUp });
        expect(yield* request("octocat", owner)).toEqual({
          state: "queued",
          requestedAt: at(start),
          syncedAt: at(start - 2 * minute),
          ...signedUp,
        });
        expect(sent).toEqual([
          { login: "octocat" as Login, mode: "incremental", requestedAt: at(start), reserved: 0, userId: ownerId },
        ]);
        expect(lookups).toEqual([]);
      }),
    ),
  );

  it.effect("bounds the owner to one sync a minute after the last one finished", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* synced("octocat", start - 30_000);
        yield* fullSynced(start - 30_000);
        expect(yield* request("octocat", owner)).toEqual({ state: "done", syncedAt: at(start - 30_000), ...signedUp });
        expect(sent).toEqual([]);

        yield* TestClock.adjust("30 seconds");
        expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start + 30_000) });
        yield* TestClock.adjust("70 seconds");
        expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start + 30_000) });
        yield* synced("octocat", start + 90_000);
        expect(yield* request("octocat", owner)).toEqual({ state: "done", syncedAt: at(start + 90_000), ...signedUp });
        expect(sent).toHaveLength(1);

        yield* TestClock.adjust("50 seconds");
        expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start + 150_000) });
        expect(sent).toHaveLength(2);
      }),
    ),
  );

  it.effect(
    "makes the owner wait 10 minutes for a first sync still reading, instead of starting a second full read",
    () =>
      admitting(({ sent }) =>
        Effect.gen(function* () {
          expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start) });
          yield* TestClock.adjust("61 seconds");
          expect(yield* request("octocat", owner)).toMatchObject({
            state: "queued",
            requestedAt: at(start),
            syncedAt: null,
          });
          yield* TestClock.adjust("8 minutes");
          yield* TestClock.adjust("58 seconds");
          yield* request("octocat", owner);
          expect(sent).toEqual([
            { login: "octocat" as Login, mode: "full", requestedAt: at(start), reserved: 0, userId: ownerId },
          ]);

          yield* TestClock.adjust("1 second");
          expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start + 600_000) });
          expect(sent).toHaveLength(2);
        }),
      ),
  );

  it.effect("answers the owner from a claim in flight without waiting on it", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* claimInFlight("octocat");
        expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start) });
        expect(sent).toEqual([]);
      }),
    ),
  );

  it.effect("queues the owner's sync now over anyone's request still waiting in line", () =>
    admitting(({ sent, delays }) =>
      Effect.gen(function* () {
        yield* fill(4_000);
        expect(yield* request("octocat")).toMatchObject({ state: "waiting", startsAt: at(start + 3_802 * unitMillis) });
        yield* TestClock.adjust("15 minutes");
        const opened = { state: "queued", requestedAt: at(start + 15 * minute), syncedAt: null, ...octocat } as const;
        expect(yield* request("octocat", owner)).toEqual(opened);
        expect(delays).toEqual([units(3_802), Duration.zero]);
        expect(sent[1]).toEqual({
          login: "octocat" as Login,
          mode: "full",
          requestedAt: at(start + 15 * minute),
          reserved: 0,
          userId: ownerId,
        });
        expect(yield* status("octocat")).toEqual(opened);

        yield* TestClock.adjust("1 minute");
        expect(yield* request("octocat", owner)).toEqual(opened);
        expect(sent).toHaveLength(2);
      }),
    ),
  );

  it.effect("runs the owner's due weekly full read now when it takes over a request still waiting in line", () =>
    admitting(({ sent, delays }) =>
      Effect.gen(function* () {
        yield* synced("octocat", start - 8 * 24 * 60 * minute);
        yield* fullSynced(start - 8 * 24 * 60 * minute);
        yield* fill(4_000);
        expect(yield* request("octocat")).toMatchObject({ state: "waiting" });
        expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start) });
        expect(sent.map((each) => each.mode)).toEqual(["incremental", "full"]);
        expect(delays[1]).toEqual(Duration.zero);
      }),
    ),
  );

  it.effect("makes the owner wait for anyone's request that is queued and no longer waiting", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* fill(300);
        expect(yield* request("octocat")).toMatchObject({ state: "waiting", startsAt: at(start + 102 * unitMillis) });
        yield* TestClock.adjust(units(102));
        yield* TestClock.adjust("9 minutes");
        expect(yield* request("octocat", owner)).toMatchObject({ state: "queued", requestedAt: at(start) });
        expect(sent).toHaveLength(1);
        yield* TestClock.adjust("1 minute");
        expect(yield* request("octocat", owner)).toMatchObject({
          state: "queued",
          requestedAt: at(start + 102 * unitMillis + 10 * minute),
        });
        expect(sent).toHaveLength(2);
      }),
    ),
  );

  it.effect("keeps the 10-minute wait for anyone after the owner's request", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* request("octocat", owner);
        yield* TestClock.adjust("9 minutes");
        expect(yield* request("octocat")).toMatchObject({ state: "queued", requestedAt: at(start) });
        expect(sent).toHaveLength(1);
        yield* TestClock.adjust("1 minute");
        expect(yield* request("octocat")).toMatchObject({ state: "queued", requestedAt: at(start + 10 * minute) });
        expect(sent).toHaveLength(2);
      }),
    ),
  );

  it.effect(
    "sends the owner a full sync once the last full read is a week old, and never while a request is queued",
    () =>
      admitting(({ sent }) =>
        Effect.gen(function* () {
          const modes = () => sent.map((each) => each.mode);
          yield* synced("octocat", start - 60 * minute);
          yield* fullSynced(start - 6 * 24 * 60 * minute);
          yield* request("octocat", owner);
          expect(modes()).toEqual(["incremental"]);

          yield* synced("octocat", start + 5_000);
          yield* TestClock.adjust("1 day");
          yield* request("octocat", owner);
          expect(modes()).toEqual(["incremental", "full"]);

          yield* TestClock.adjust("2 minutes");
          yield* request("octocat", owner);
          expect(modes()).toEqual(["incremental", "full"]);

          yield* TestClock.adjust("8 minutes");
          yield* request("octocat", owner);
          expect(modes()).toEqual(["incremental", "full", "incremental"]);

          const fullRequest = start + 24 * 60 * minute;
          yield* fullSynced(fullRequest + 1_000);
          yield* synced("octocat", fullRequest + 10 * minute + 1_000);
          yield* TestClock.adjust("2 minutes");
          yield* request("octocat", owner);
          expect(modes()).toEqual(["incremental", "full", "incremental", "incremental"]);
        }),
      ),
  );
});

it.layer(memory, { timeout: 30_000 })("SyncRequests with a failing queue", (it) => {
  it.effect("reports the request failed instead of queued", () =>
    admitting(
      () =>
        Effect.gen(function* () {
          expect((yield* Effect.flip(request("octocat")))._tag).toBe("SyncQueueFailed");
          expect(yield* status("octocat")).toEqual({
            state: "failed",
            requestedAt: at(start),
            syncedAt: null,
            ...octocat,
          });
        }),
      { sender: brokenQueue },
    ),
  );

  it.effect("gives the line back what it reserved for a sync the queue refused, and keeps the lookup", () =>
    admitting(
      () =>
        Effect.gen(function* () {
          yield* fill(300);
          yield* Effect.flip(request("octocat"));
          expect(yield* lineUnits()).toBe(300 + 1);
          yield* Effect.flip(request("hubot", owner));
          expect(yield* lineUnits()).toBe(300 + 1);
        }),
      { sender: brokenQueue },
    ),
  );

  it.effect("settles a waiting request failed without a start, so it never holds the login past its cooldown", () =>
    admitting(
      () =>
        Effect.gen(function* () {
          yield* fill(300);
          expect((yield* Effect.flip(request("octocat")))._tag).toBe("SyncQueueFailed");
          expect(yield* row("octocat")).toEqual(
            Option.some({ login: "octocat", requestedAt: at(start), outcome: "failed", startsAt: null }),
          );
          expect(yield* status("octocat")).toMatchObject({ state: "failed" });
          yield* TestClock.adjust("10 minutes");
          expect(yield* Effect.flip(request("octocat", anyone("caller-b")))).toMatchObject({ _tag: "SyncQueueFailed" });
        }),
      { sender: brokenQueue },
    ),
  );
});

it.effect("prices the GitHub requests a sync makes", () =>
  Effect.sync(() => {
    const since = (starredTotal: number, storedStars: number) =>
      ({ _tag: "since", starredTotal, storedStars }) as const;
    expect(SyncRequests.lookupCost).toBe(1);
    expect(SyncRequests.costOf(since(2_431, 2_431))).toBe(2);
    expect(SyncRequests.costOf(since(2_431, 2_500))).toBe(2);
    expect(SyncRequests.costOf(since(2_431, 2_333))).toBe(2);
    expect(SyncRequests.costOf(since(2_431, 2_332))).toBe(3);
    expect(SyncRequests.costOf(since(501, 1))).toBe(7);
    expect(SyncRequests.costOf({ _tag: "every", starredTotal: 0 })).toBe(4);
    expect(SyncRequests.costOf({ _tag: "every", starredTotal: 2_431 })).toBe(28);
  }),
);
