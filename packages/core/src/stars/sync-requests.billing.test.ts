import { expect } from "bun:test";
import * as TestDatabase from "@stargrep/db/test-database";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import type { LoginSyncRequest } from "./star-sync.ts";
import { admitting, anyone, lineUnits, memory, request, share, unitMillis, units } from "./sync-requests.fixture.ts";
import * as SyncRequests from "./sync-requests.ts";

const settle = (body: LoginSyncRequest, counted: number, attempts = 1) =>
  SyncRequests.billDelivery(share, { body, attempts }, counted);

const nth = (sent: ReadonlyArray<LoginSyncRequest>, index: number) => {
  const body = sent[index];
  if (body === undefined) throw new Error(`no sync number ${index} was queued`);
  return body;
};

const releasedUnits = TestDatabase.TestDatabase.use((database) =>
  database.query("select released_ms from rate_lines where key = 'all'"),
).pipe(
  Effect.map((rows) => Number((rows as ReadonlyArray<{ readonly released_ms: number }>)[0]?.released_ms) / unitMillis),
);

// Each login has 42 stars, so a signed-out first read reserves 4 units after a forced lookup of 1. octocat's lookup and
// read take units 0 to 5 of the line, and hubot's take units 5 to 10.
const admitTwo = Effect.gen(function* () {
  yield* request("octocat", anyone("caller-a"));
  yield* request("hubot", anyone("caller-b"));
  expect(yield* lineUnits()).toBe(10);
});

it.layer(memory, { timeout: 30_000 })("SyncRequests billing", (it) => {
  it.effect("gives back the unused end of a first delivery's reservation while the line still owes it", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* admitTwo;
        yield* settle(nth(sent, 0), 1);
        expect(yield* lineUnits()).toBe(7);
      }),
    ),
  );

  it.effect("gives back only the part of the unused end the line has not paid out", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* admitTwo;
        yield* TestClock.adjust(units(3));
        yield* settle(nth(sent, 0), 1);
        expect(yield* lineUnits()).toBe(5);
      }),
    ),
  );

  it.effect("gives back nothing once the line paid the reservation out, so the sync behind it keeps its debt", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* admitTwo;
        yield* TestClock.adjust(units(6));
        yield* settle(nth(sent, 0), 1);
        expect(yield* lineUnits()).toBe(4);
      }),
    ),
  );

  it.effect("gives back the whole reservation of a first delivery that failed before it sent a request", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* admitTwo;
        yield* settle(nth(sent, 0), 0);
        expect(yield* lineUnits()).toBe(6);
      }),
    ),
  );

  it.effect("bills what a first delivery spent past its reservation", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* admitTwo;
        yield* settle(nth(sent, 0), 7);
        expect(yield* lineUnits()).toBe(13);
      }),
    ),
  );

  it.effect("gives back once for a delivery, and bills every request of its retry and of its deferred copy", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* admitTwo;
        const body = nth(sent, 0);
        yield* settle(body, 1);
        expect(yield* lineUnits()).toBe(7);
        yield* settle(body, 1, 2);
        expect(yield* lineUnits()).toBe(8);
        yield* settle(Option.getOrThrow(SyncRequests.resent(body)), 2);
        expect(yield* lineUnits()).toBe(10);
      }),
    ),
  );

  it.effect("owes what the syncs spent, and its released total is what they did not use", () =>
    admitting(({ sent }) =>
      Effect.gen(function* () {
        yield* admitTwo;
        yield* request("grace", anyone("caller-c"));
        yield* settle(nth(sent, 0), 1);
        yield* settle(nth(sent, 1), 4);
        yield* settle(nth(sent, 2), 9);
        expect(yield* lineUnits()).toBe(3 + 1 + 4 + 9);
        expect(yield* releasedUnits).toBe(3);
      }),
    ),
  );
});
