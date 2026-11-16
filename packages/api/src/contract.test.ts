import { expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { SearchInput, SyncStatus } from "./contract.ts";

const acceptsSearch = Schema.is(Schema.toEncoded(SearchInput));
const acceptsStatus = Schema.is(SyncStatus);
const time = "2026-11-05T10:00:00.000Z";
const common = {
  login: "ada",
  accountType: "user",
  starredTotal: 42,
  enrichment: { total: 42, read: 20, failed: 1, queued: 0 },
};

test("search accepts the available scope and rejects scopes that have not shipped", () => {
  expect(acceptsSearch({ scope: { kind: "stars", login: "ada" }, q: "terminal dashboards" })).toBe(true);
  for (const scope of [{ kind: "global" }, { kind: "network" }, { kind: "stars" }, "stars"])
    expect(acceptsSearch({ scope, q: "terminal dashboards" })).toBe(false);
});

test("sync states preserve the JSON fields and require their own timestamps and waiting data", () => {
  const states = [
    { state: "unknown", requestedAt: null, syncedAt: null, waiting: null },
    { state: "waiting", requestedAt: time, syncedAt: null, waiting: { startsAt: time, ahead: 2 } },
    { state: "queued", requestedAt: time, syncedAt: null, waiting: null },
    { state: "failed", requestedAt: time, syncedAt: time, waiting: null },
    { state: "done", requestedAt: null, syncedAt: time, waiting: null },
  ];
  for (const state of states) expect(acceptsStatus({ ...common, ...state })).toBe(true);
  for (const state of [
    { state: "unknown", requestedAt: time, syncedAt: null, waiting: null },
    { state: "waiting", requestedAt: time, syncedAt: null, waiting: null },
    { state: "queued", requestedAt: null, syncedAt: null, waiting: null },
    { state: "failed", requestedAt: time, syncedAt: null, waiting: { startsAt: time, ahead: 2 } },
    { state: "done", requestedAt: null, syncedAt: null, waiting: null },
  ])
    expect(acceptsStatus({ ...common, ...state })).toBe(false);
});
