import { expect } from "bun:test";
import type * as Db from "@stargrep/db";
import { DbQueryFailed } from "@stargrep/db/errors";
import type { Login } from "@stargrep/github/schemas";
import { collectSpans } from "@stargrep/telemetry/collector";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as OwnerLookup from "./owner-lookup.ts";
import type { LoginSyncRequest } from "./star-sync.ts";
import * as SyncQueue from "./sync-queue.ts";
import {
  admitted,
  admitting,
  anyone,
  at,
  brokenQueue,
  claimInFlight,
  fill,
  fillNetwork,
  fullSynced,
  lineUnits,
  markFailed,
  memory,
  minute,
  networkUnits,
  octocat,
  org,
  owner,
  ownerId,
  request,
  row,
  signedIn,
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
        expect(sent).toEqual([
          {
            login: "octocat" as Login,
            mode: "incremental",
            requestedAt: at(start),
            reserved: { units: 4, endsAt: at(start + 5 * unitMillis), generation: expect.any(Number), released: 0 },
          },
        ]);

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
          { login: "octocat" as Login, mode: "incremental", requestedAt: at(start), userId: ownerId },
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
          expect(sent).toEqual([{ login: "octocat" as Login, mode: "full", requestedAt: at(start), userId: ownerId }]);

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

  it.effect("gives a new login's first read back to its network when the queue refuses its sync", () =>
    admitting(
      () =>
        Effect.gen(function* () {
          expect((yield* Effect.flip(request("octocat")))._tag).toBe("SyncQueueFailed");
          expect(yield* networkUnits()).toBe(1);
          expect(yield* lineUnits()).toBe(1);
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

it.layer(memory, { timeout: 30_000 })("SyncRequests stopped after a claim", (it) => {
  // The first send waits until the test lets the queue refuse it. Every later send goes through.
  const lateRefusal = Effect.gen(function* () {
    const sending = yield* Deferred.make<void>();
    const refuse = yield* Deferred.make<void>();
    const sent: Array<LoginSyncRequest> = [];
    let first = true;
    const layer = Layer.succeed(
      SyncQueue.SyncQueue,
      SyncQueue.SyncQueue.of({
        send: (message) =>
          Effect.suspend(() => {
            if (!first) return Effect.sync(() => void sent.push(message));
            first = false;
            return Deferred.succeed(sending, undefined).pipe(
              Effect.andThen(Deferred.await(refuse)),
              Effect.andThen(Effect.fail(new SyncQueue.SyncQueueFailed({ cause: "refused late" }))),
            );
          }),
      }),
    );
    return { sending, refuse, sent, layer };
  });

  it.effect("gives back nothing the lines have paid out when the queue refuses a sync late", () =>
    Effect.gen(function* () {
      const queue = yield* lateRefusal;
      yield* admitting(
        () =>
          Effect.gen(function* () {
            const refused = yield* Effect.forkChild(Effect.exit(request("octocat")));
            yield* Deferred.await(queue.sending);
            yield* TestClock.adjust("121 seconds");
            expect(yield* request("hubot")).toMatchObject({ state: "queued" });
            yield* Deferred.succeed(queue.refuse, undefined);
            yield* Fiber.join(refused);
            expect(yield* networkUnits()).toBe(5);
            expect(yield* lineUnits()).toBe(5);
            expect(yield* row("octocat")).toMatchObject(Option.some({ outcome: "failed" }));
            expect(queue.sent.map((message) => message.login)).toEqual(["hubot" as Login]);
          }),
        { sender: queue.layer },
      );
    }),
  );

  it.effect("gives back only what is left of a sync an earlier refusal moved, and keeps later work's charges", () =>
    Effect.gen(function* () {
      const held = new Map<
        string,
        { readonly sending: Deferred.Deferred<void>; readonly refuse: Deferred.Deferred<void> }
      >();
      for (const login of ["octocat", "hubot"]) {
        held.set(login, { sending: yield* Deferred.make<void>(), refuse: yield* Deferred.make<void>() });
      }
      const hold = (login: string) => {
        const found = held.get(login);
        if (found === undefined) throw new Error(`no hold for ${login}`);
        return found;
      };
      const sent: Array<Login> = [];
      // The queue holds the syncs of octocat and hubot until the test refuses them, and takes every other one.
      const holding = Layer.succeed(
        SyncQueue.SyncQueue,
        SyncQueue.SyncQueue.of({
          send: (message) =>
            Effect.suspend(() => {
              const found = held.get(message.login);
              if (found === undefined) return Effect.sync(() => void sent.push(message.login));
              return Deferred.succeed(found.sending, undefined).pipe(
                Effect.andThen(Deferred.await(found.refuse)),
                Effect.andThen(Effect.fail(new SyncQueue.SyncQueueFailed({ cause: "refused" }))),
              );
            }),
        }),
      );
      yield* admitting(
        () =>
          Effect.gen(function* () {
            const first = yield* Effect.forkChild(Effect.exit(request("octocat")));
            yield* Deferred.await(hold("octocat").sending);
            const second = yield* Effect.forkChild(Effect.exit(request("hubot")));
            yield* Deferred.await(hold("hubot").sending);
            expect(yield* request("grace")).toMatchObject({ state: "queued" });
            yield* Deferred.succeed(hold("octocat").refuse, undefined);
            yield* Fiber.join(first);
            yield* TestClock.adjust("9 seconds");
            yield* Deferred.succeed(hold("hubot").refuse, undefined);
            yield* Fiber.join(second);
            expect(yield* lineUnits()).toBe(5);
            expect(yield* networkUnits()).toBe(5 + 1 + 1 - 9 / 24);
            expect(sent).toEqual(["grace" as Login]);
          }),
        { sender: holding },
      );
    }),
  );

  it.effect("keeps a newer claim and its charges when the queue refuses the older request late", () =>
    Effect.gen(function* () {
      const queue = yield* lateRefusal;
      yield* admitting(
        () =>
          Effect.gen(function* () {
            const refused = yield* Effect.forkChild(Effect.exit(request("octocat")));
            yield* Deferred.await(queue.sending);
            yield* TestClock.adjust("11 minutes");
            expect(yield* request("octocat")).toMatchObject({ state: "queued", requestedAt: at(start + 11 * minute) });
            yield* Deferred.succeed(queue.refuse, undefined);
            yield* Fiber.join(refused);
            expect(yield* networkUnits()).toBe(5);
            expect(yield* lineUnits()).toBe(5);
            expect(yield* row("octocat")).toMatchObject(
              Option.some({ outcome: "pending", requestedAt: at(start + 11 * minute) }),
            );
          }),
        { sender: queue.layer },
      );
    }),
  );

  const lineDown = new DbQueryFailed({ operation: "rateLines.reserve", reason: "transport", sqlState: null });

  // Fails the turn a sync takes in the line all, after its claim and its network's first read.
  const turnFails = (db: Db.Db["Service"]): Db.Db["Service"] => ({
    ...db,
    rateLines: {
      ...db.rateLines,
      reserve: (reservation) =>
        reservation.line === "all" && !reservation.force ? Effect.fail(lineDown) : db.rateLines.reserve(reservation),
    },
  });

  // Someone's trigger claims the login as missing just before this request's claim lands.
  const missingFirst = (db: Db.Db["Service"]): Db.Db["Service"] => ({
    ...db,
    syncRequests: {
      ...db.syncRequests,
      claim: (claim) =>
        db.syncRequests
          .claim({ ...claim, overtakesWaiting: false, outcome: "missing" })
          .pipe(Effect.andThen(db.syncRequests.claim(claim))),
    },
  });

  it.effect("releases the claim and gives back the first read when a query fails before the sync goes out", () =>
    admitting(
      ({ sent }) =>
        Effect.gen(function* () {
          expect(yield* Effect.flip(request("octocat"))).toMatchObject({ _tag: "DbQueryFailed" });
          expect(yield* row("octocat")).toEqual(Option.none());
          expect(yield* networkUnits()).toBe(1);
          expect(yield* lineUnits()).toBe(1);
          expect(sent).toEqual([]);
        }),
      { hooks: { queries: turnFails } },
    ),
  );

  it.effect(
    "releases the claim and gives back every charge when the request is interrupted before its sync goes out",
    () =>
      Effect.gen(function* () {
        const reserving = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        // The turn in the line all waits at the gate, so the interruption lands while the request holds its charges.
        const holdTurn = (db: Db.Db["Service"]): Db.Db["Service"] => ({
          ...db,
          rateLines: {
            ...db.rateLines,
            reserve: (reservation) =>
              reservation.line === "all" && !reservation.force
                ? Deferred.succeed(reserving, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.andThen(db.rateLines.reserve(reservation)),
                  )
                : db.rateLines.reserve(reservation),
          },
        });
        yield* admitting(
          ({ sent }) =>
            Effect.gen(function* () {
              const requested = yield* Effect.forkChild(request("octocat"));
              yield* Deferred.await(reserving);
              expect(yield* row("octocat")).toMatchObject(Option.some({ outcome: "claimed" }));
              expect(yield* networkUnits()).toBe(5);
              const interrupting = yield* Effect.forkChild(Fiber.interrupt(requested));
              yield* Effect.yieldNow;
              yield* Deferred.succeed(gate, undefined);
              yield* Fiber.join(interrupting);
              expect(yield* row("octocat")).toEqual(Option.none());
              expect(yield* networkUnits()).toBe(1);
              expect(yield* lineUnits()).toBe(1);
              expect(sent).toEqual([]);
            }),
          { hooks: { queries: holdTurn } },
        );
      }),
  );

  it.effect("keeps the claim and its charges when the request is interrupted while its message is being sent", () =>
    Effect.gen(function* () {
      const queued = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const sent: Array<LoginSyncRequest> = [];
      // The queue takes the message, then answers only once the gate opens.
      const accepted = Layer.succeed(
        SyncQueue.SyncQueue,
        SyncQueue.SyncQueue.of({
          send: (message) =>
            Effect.sync(() => sent.push(message)).pipe(
              Effect.andThen(Deferred.succeed(queued, undefined)),
              Effect.andThen(Deferred.await(gate)),
            ),
        }),
      );
      yield* admitting(
        () =>
          Effect.gen(function* () {
            const requested = yield* Effect.forkChild(request("octocat"));
            yield* Deferred.await(queued);
            const interrupting = yield* Effect.forkChild(Fiber.interrupt(requested));
            yield* Effect.yieldNow;
            yield* Deferred.succeed(gate, undefined);
            yield* Fiber.join(interrupting);
            expect(yield* row("octocat")).toMatchObject(Option.some({ outcome: "claimed" }));
            expect(yield* networkUnits()).toBe(5);
            expect(yield* lineUnits()).toBe(5);
            expect(yield* status("octocat")).toMatchObject({ state: "queued" });
            expect(sent).toHaveLength(1);
          }),
        { sender: accepted },
      );
    }),
  );

  // A signed-out request claims the login and starts waiting while the signed-in request looks it up.
  const waitsDuringLookup = (db: Db.Db["Service"]) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const login = "octocat" as Login;
      yield* db.syncRequests.claim({
        login,
        at: now,
        cooldown: Duration.minutes(10),
        overtakesWaiting: false,
        outcome: "claimed",
      });
      yield* db.syncRequests.schedule(login, now, DateTime.addDuration(now, Duration.hours(1)));
    }).pipe(Effect.orDie);

  it.effect("answers a signed-in request from a signed-out one that started waiting during its lookup", () =>
    admitting(
      ({ sent }) =>
        Effect.gen(function* () {
          yield* fillNetwork(149);
          expect(yield* request("octocat", signedIn())).toMatchObject({ state: "waiting", requestedAt: at(start) });
          expect(yield* row("octocat")).toMatchObject(
            Option.some({ outcome: "pending", startsAt: at(start + 60 * minute) }),
          );
          expect(yield* networkUnits()).toBe(150);
          expect(sent).toEqual([]);
        }),
      { hooks: { duringLookup: waitsDuringLookup } },
    ),
  );

  it.effect("records no lookup cost for an owner who loses the claim to a login GitHub does not have", () =>
    admitting(
      () =>
        Effect.gen(function* () {
          const collected = collectSpans();
          const refused = yield* Effect.flip(request("octocat", owner).pipe(Effect.withTracer(collected.tracer)));
          expect(refused).toMatchObject({ _tag: "LoginNotFound" });
          const span = collected.named("SyncRequests.request");
          expect(span?.attributes.get("sync.admission.decision")).toBe("not-found");
          expect(span?.attributes.get("sync.admission.cost")).toBe(0);
        }),
      { hooks: { queries: missingFirst } },
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
