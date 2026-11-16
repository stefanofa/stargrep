import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import type { SyncStatus } from "../src/lib/rpc.ts";
import { SyncFailed, SyncRefused, type SyncWatch, watchSync } from "../src/lib/sync-watch.ts";
import { syncStatus } from "./sync-status.fixture.ts";

const harness = Effect.fn("test.watch")(function* (initial: SyncStatus) {
  let current = initial;
  let shown = true;
  let reads = 0;
  let progress = 0;
  const visible = yield* Queue.unbounded<void>();
  const changes: Array<SyncWatch> = [];
  const fiber = yield* Effect.forkChild(
    watchSync({
      initial,
      retry: false,
      own: false,
      read: Effect.sync(() => {
        reads++;
        return current;
      }),
      trigger: Effect.succeed(initial),
      visible: Queue.take(visible),
      whenVisible: Effect.suspend(() => (shown ? Effect.void : Queue.take(visible))),
      changed: (watch) => changes.push(watch),
      progressed: () => {
        progress++;
      },
      refused: () => {},
    }),
  );
  yield* TestClock.adjust(0);
  return {
    changes,
    fiber,
    reads: () => reads,
    progress: () => progress,
    status: (status: SyncStatus) => {
      current = status;
    },
    hide: () => {
      shown = false;
    },
    show: () => {
      shown = true;
      return Queue.offer(visible, undefined);
    },
  };
});

for (const [state, status, milliseconds] of [
  ["queued", syncStatus({ state: "queued" }), 2000],
  ["waiting", syncStatus({ state: "waiting", waiting: { startsAt: "2026-11-06T09:01:30.500Z", ahead: 2 } }), 10000],
  ["reading", syncStatus({ enrichment: { total: 10, read: 4, failed: 0, queued: 0 } }), 5000],
  ["done", syncStatus({ state: "done" }), 30000],
  ["queued for later", syncStatus({ enrichment: { total: 10, read: 4, failed: 1, queued: 5 } }), 30000],
] as const) {
  it.effect(`polls ${state} at its interval without reloading an unchanged library`, () =>
    Effect.gen(function* () {
      const watch = yield* harness(status);
      expect(watch.reads()).toBe(1);
      yield* TestClock.adjust(milliseconds - 1);
      expect(watch.reads()).toBe(1);
      yield* TestClock.adjust(1);
      expect(watch.reads()).toBe(2);
      expect(watch.progress()).toBe(0);
    }),
  );
}

it.effect("does not poll a hidden tab and reads immediately when it becomes visible", () =>
  Effect.gen(function* () {
    const watch = yield* harness(syncStatus({ state: "queued" }));
    watch.hide();
    yield* TestClock.adjust("1 minute");
    expect(watch.reads()).toBe(1);
    yield* watch.show();
    yield* TestClock.adjust(0);
    expect(watch.reads()).toBe(2);
    yield* Fiber.interrupt(watch.fiber);
    yield* TestClock.adjust("1 hour");
    expect(watch.reads()).toBe(2);
  }),
);

it.effect("reloads for imported stars, changed enrichment and completion, while keeping unchanged polls still", () =>
  Effect.gen(function* () {
    const watch = yield* harness(
      syncStatus({ state: "queued", enrichment: { total: 10, read: 10, failed: 0, queued: 0 } }),
    );
    watch.status(syncStatus({ enrichment: { total: 10, read: 10, failed: 0, queued: 0 } }));
    yield* TestClock.adjust("2 seconds");
    expect(watch.progress()).toBe(1);
    watch.status(syncStatus({ enrichment: { total: 11, read: 10, failed: 0, queued: 0 } }));
    yield* watch.show();
    yield* TestClock.adjust(0);
    expect(watch.progress()).toBe(2);
    yield* TestClock.adjust("5 seconds");
    expect(watch.progress()).toBe(2);
  }),
);

it.effect("an unknown login triggers once, and a refusal waits for the visitor to retry", () =>
  Effect.gen(function* () {
    const changes: Array<SyncWatch> = [];
    let triggered = 0;
    yield* Effect.forkChild(
      watchSync({
        initial: undefined,
        retry: false,
        own: false,
        read: Effect.succeed(syncStatus({ state: "unknown" })),
        trigger: Effect.sync(() => {
          triggered++;
        }).pipe(Effect.andThen(Effect.fail(new SyncRefused({ refusal: "busy" })))),
        visible: Effect.never,
        whenVisible: Effect.void,
        changed: (watch) => changes.push(watch),
        progressed: () => {},
        refused: () => {},
      }),
    );
    yield* TestClock.adjust("1 hour");
    expect(triggered).toBe(1);
    expect(changes).toEqual([{ kind: "busy" }]);
  }),
);

it.effect("a failed status read keeps the previous polling interval and recovers at the next poll", () =>
  Effect.gen(function* () {
    const previous = syncStatus({ state: "queued" });
    const changes: Array<SyncWatch> = [];
    let reads = 0;
    yield* Effect.forkChild(
      watchSync({
        initial: previous,
        retry: false,
        own: false,
        read: Effect.suspend(() =>
          reads++ === 0 ? Effect.fail(new SyncFailed({ cause: "offline" })) : Effect.succeed(previous),
        ),
        trigger: Effect.die("a known status must not trigger"),
        visible: Effect.never,
        whenVisible: Effect.void,
        changed: (watch) => changes.push(watch),
        progressed: () => {},
        refused: () => {},
      }),
    );
    yield* TestClock.adjust("1999 millis");
    expect(reads).toBe(1);
    expect(changes).toEqual([]);
    yield* TestClock.adjust("1 millis");
    expect(reads).toBe(2);
    expect(changes).toEqual([{ kind: "watching", status: previous, at: 2000 }]);
  }),
);

const ownerWatch = (trigger: Effect.Effect<SyncStatus, SyncRefused>) =>
  Effect.gen(function* () {
    const changes: Array<SyncWatch> = [];
    const refused: Array<string> = [];
    let reads = 0;
    yield* Effect.forkChild(
      watchSync({
        initial: syncStatus({ state: "done" }),
        retry: false,
        own: true,
        read: Effect.sync(() => {
          reads++;
          return syncStatus({ state: "failed" });
        }),
        trigger,
        visible: Effect.never,
        whenVisible: Effect.void,
        changed: (watch) => changes.push(watch),
        progressed: () => {},
        refused: (refusal) => refused.push(refusal),
      }),
    );
    yield* TestClock.adjust(0);
    return { changes, refused, reads: () => reads };
  });

it.effect("the owner's page asks for a sync when it opens, before it reads anything", () =>
  Effect.gen(function* () {
    const queued = syncStatus({ state: "queued" });
    const watch = yield* ownerWatch(Effect.succeed(queued));
    expect([watch.changes, watch.reads()]).toEqual([[{ kind: "watching", status: queued, at: 0 }], 0]);
  }),
);

it.effect("a refused ask from the owner reads the status instead, so their library stays on screen", () =>
  Effect.gen(function* () {
    const watch = yield* ownerWatch(Effect.fail(new SyncRefused({ refusal: "limited" })));
    expect(watch.changes).toEqual([{ kind: "watching", status: syncStatus({ state: "failed" }), at: 0 }]);
    expect([watch.refused, watch.reads()]).toEqual([[], 1]);
  }),
);
