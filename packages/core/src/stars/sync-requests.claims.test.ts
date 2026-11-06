import { expect } from "bun:test";
import type * as Db from "@stargrep/db";
import type { DbQueryFailed } from "@stargrep/db/errors";
import * as TestDatabase from "@stargrep/db/test-database";
import * as it from "@stargrep/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import {
  admitting,
  anyone,
  claimInFlight,
  embeddingModel,
  holdLookups,
  lineUpClaims,
  memory,
  outcomeOf,
  request,
  reserveUnits,
  row,
  status,
} from "./sync-requests.fixture.ts";
import type * as SyncRequests from "./sync-requests.ts";

const cases = (test: { readonly effect: it.Tester<Db.Db | TestDatabase.TestDatabase> }) => {
  test.effect("queues one job when the same login is triggered many times at once, and answers each queued", () =>
    Effect.gen(function* () {
      const claiming = yield* lineUpClaims(6);
      yield* admitting(
        ({ sent, lookups }) =>
          Effect.gen(function* () {
            const answers = yield* Effect.forEach(
              Array.from({ length: 6 }, (_, index) => `caller-${index}`),
              (caller) => request("swarm", anyone(caller)),
              { concurrency: "unbounded" },
            );
            expect(sent).toHaveLength(1);
            expect(lookups).toHaveLength(6);
            expect(answers.map((answer) => answer.state)).toEqual(Array.from({ length: 6 }, () => "queued"));
          }),
        { hooks: { claiming } },
      );
    }),
  );

  test.effect("answers every trigger for a missing login not found, those that lose the claim included", () =>
    Effect.gen(function* () {
      const claiming = yield* lineUpClaims(3);
      yield* admitting(
        ({ sent }) =>
          Effect.gen(function* () {
            const results = yield* Effect.forEach(
              ["caller-0", "caller-1", "caller-2"],
              (caller) => Effect.result(request("missing-login", anyone(caller))),
              { concurrency: "unbounded" },
            );
            expect(results.map(outcomeOf)).toEqual(["LoginNotFound", "LoginNotFound", "LoginNotFound"]);
            expect(sent).toEqual([]);
          }),
        { hooks: { claiming } },
      );
    }),
  );

  test.effect("answers triggers that arrive during a missing login's lookup not found", () =>
    Effect.gen(function* () {
      const lookup = yield* holdLookups;
      yield* admitting(
        ({ sent }) =>
          Effect.gen(function* () {
            const trigger = (caller: string) =>
              Effect.forkChild(Effect.result(request("missing-login", anyone(caller))));
            const first = yield* trigger("caller-0");
            yield* Deferred.await(lookup.looking);
            const others = [yield* trigger("caller-1"), yield* trigger("caller-2")];
            yield* Deferred.succeed(lookup.answer, undefined);
            const outcomes = (yield* Fiber.joinAll([first, ...others])).map(outcomeOf);
            expect(outcomes).toEqual(["LoginNotFound", "LoginNotFound", "LoginNotFound"]);
            expect(sent).toEqual([]);
          }),
        { hooks: { duringLookup: lookup.hook } },
      );
    }),
  );
};

it.layer(memory, { timeout: 30_000 })("PGlite SyncRequests claims at once", cases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel }), { timeout: 30_000 })(
  "node-postgres SyncRequests claims at once",
  cases,
);

it.layer(memory, { timeout: 30_000 })("SyncRequests claims", (it) => {
  it.effect("answers a trigger that finds a claim in flight from its row at once, without a lookup", () =>
    admitting(({ sent, lookups }) =>
      Effect.gen(function* () {
        yield* claimInFlight("swarm");
        expect(yield* request("swarm", anyone("caller-b"))).toMatchObject({ state: "queued" });
        expect(lookups).toEqual([]);
        expect(sent).toEqual([]);
      }),
    ),
  );

  it.effect("answers queued from a claim the line then refuses, the one window with no job behind that answer", () =>
    Effect.gen(function* () {
      const claimed = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      let first = true;
      const claiming = (claim: Effect.Effect<boolean, DbQueryFailed>) =>
        Effect.tap(claim, (won) => {
          if (!won || !first) return Effect.void;
          first = false;
          return Deferred.succeed(claimed, undefined).pipe(Effect.andThen(Deferred.await(proceed)));
        });
      yield* admitting(
        ({ sent }) =>
          Effect.gen(function* () {
            const refused = yield* Effect.forkChild(Effect.flip(request("swarm")));
            yield* Deferred.await(claimed);
            const answer: SyncRequests.SyncStatus = yield* request("swarm", anyone("caller-b"));
            expect(answer).toMatchObject({ state: "queued" });
            yield* Deferred.succeed(proceed, undefined);
            expect(yield* Fiber.join(refused)).toMatchObject({ _tag: "SyncBusy", reason: "line-full" });
            expect(sent).toEqual([]);
            expect(yield* row("swarm")).toEqual(Option.none());
            expect(yield* status("swarm")).toMatchObject({ state: "unknown" });
          }),
        { hooks: { duringLookup: (db) => reserveUnits(db, 4_500), claiming } },
      );
    }),
  );
});
