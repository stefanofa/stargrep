import { ORPCError } from "@orpc/client";
import * as DateTime from "effect/DateTime";
import { fixtureAccounts, fixtureConfig, fixtureRepos } from "./planned-fixtures.ts";
import type { Client, LibraryRepo, OwnerType, SyncStatus } from "./rpc.ts";

// A client with the surface of #48 (`feat(api): search anyone's stars safely`), whose procedures answer from fixtures
// until it merges. Then `planned(api())` becomes `api()`, and this file and its fixtures go.

export interface PlannedSyncStatus extends Omit<SyncStatus, "state"> {
  readonly state: SyncStatus["state"] | "waiting";
  readonly waiting: { readonly ahead: number; readonly startsAt: string } | null;
  readonly starredTotal: number | null;
  readonly accountType: OwnerType | null;
}

export interface PublicConfig {
  readonly demoLogin: string;
  readonly demoQuery: string;
  readonly examples: ReadonlyArray<string>;
  readonly featured: ReadonlyArray<string>;
}

export interface PublicStars {
  readonly login: string;
  readonly repos: ReadonlyArray<LibraryRepo>;
  readonly nextCursor: string | null;
}

type Options = { readonly signal?: AbortSignal };

export interface PlannedClient {
  readonly viewer: Client["viewer"];
  readonly library: Client["library"];
  readonly search: Client["search"];
  readonly syncStatus: (input: { login: string }, options?: Options) => Promise<PlannedSyncStatus>;
  readonly triggerSync: (input: { login: string }, options?: Options) => Promise<PlannedSyncStatus>;
  readonly stars: (
    input: { login: string; limit?: number; cursor?: string },
    options?: Options,
  ) => Promise<PublicStars>;
  readonly config: (input?: undefined, options?: Options) => Promise<PublicConfig>;
}

const accountOf = (login: string) => fixtureAccounts.find((account) => account.login === login.toLowerCase());

const minute = 60_000;

const withPlanned = (status: SyncStatus): PlannedSyncStatus => {
  const account = accountOf(status.login);
  const waiting = account?.waiting;
  const planned = {
    ...status,
    waiting: null,
    starredTotal: account?.starredTotal ?? null,
    accountType: account === undefined ? null : ("user" as const),
  };
  if (waiting === undefined) return planned;
  const startsAt = DateTime.formatIso(
    DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) + waiting.minutes * minute),
  );
  return { ...planned, state: "waiting", syncedAt: null, waiting: { ahead: waiting.ahead, startsAt } };
};

const refusals = {
  LOGIN_NOT_FOUND: { status: 404, message: "GitHub has no user or org with this login." },
  SYNC_BUSY: {
    status: 503,
    message: "Stargrep is importing as many accounts as GitHub allows right now. Try again later.",
  },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many requests from your network. Try again in a minute." },
  ACCOUNT_NOT_SYNCED: {
    status: 404,
    message: "Stargrep has not synced this login's stars yet. Trigger a sync first.",
  },
} as const;

const refuse = (code: keyof typeof refusals) => new ORPCError(code, refusals[code]);

const page = 1000;

export const planned = (client: Client): PlannedClient => ({
  viewer: (input, options) => client.viewer(input, options),
  library: (input, options) => client.library(input, options),
  search: (input, options) => client.search(input, options),
  config: async () => fixtureConfig,
  syncStatus: (input, options) => client.syncStatus(input, options).then(withPlanned),
  triggerSync: async (input, options) => {
    const account = accountOf(input.login);
    if (account === undefined) throw refuse("LOGIN_NOT_FOUND");
    if (account.refuses !== undefined) throw refuse(account.refuses);
    return withPlanned(await client.triggerSync(input, options));
  },
  stars: async ({ login, limit = page, cursor }) => {
    const arrived = fixtureRepos.slice(0, accountOf(login)?.arrived ?? 0);
    if (arrived.length === 0) throw refuse("ACCOUNT_NOT_SYNCED");
    const from = cursor === undefined ? 0 : Number(cursor.split("-")[0]);
    const to = from + limit;
    return { login, repos: arrived.slice(from, to), nextCursor: to < arrived.length ? `${to}-0` : null };
  },
});
