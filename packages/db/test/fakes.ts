import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Db from "../src/db.ts";

export { accountRow, repo } from "./fixtures.ts";
export { summarize } from "./summaries.ts";

type Overrides = { readonly [Group in keyof Db.Db["Service"]]?: Partial<Db.Db["Service"][Group]> };

const unexpected = (query: string) => () => Effect.die(new Error(`Unexpected Db query: ${query}`));

const defaults = {
  accounts: {
    upsert: unexpected("accounts.upsert"),
    upsertLooked: unexpected("accounts.upsertLooked"),
    claim: unexpected("accounts.claim"),
    claimedBy: unexpected("accounts.claimedBy"),
    get: unexpected("accounts.get"),
    byLogin: unexpected("accounts.byLogin"),
    require: unexpected("accounts.require"),
    setOwnedRepoStars: unexpected("accounts.setOwnedRepoStars"),
    setStarredCount: unexpected("accounts.setStarredCount"),
    recordStarSync: unexpected("accounts.recordStarSync"),
  },
  repos: {
    upsertRefs: unexpected("repos.upsertRefs"),
    pendingEnrichment: unexpected("repos.pendingEnrichment"),
    saveFacts: unexpected("repos.saveFacts"),
    saveCounts: unexpected("repos.saveCounts"),
    saveFactsAndLease: unexpected("repos.saveFactsAndLease"),
    summarized: unexpected("repos.summarized"),
    saveEmbedding: unexpected("repos.saveEmbedding"),
    saveIcon: unexpected("repos.saveIcon"),
    saveOwners: unexpected("repos.saveOwners"),
    dueIcons: unexpected("repos.dueIcons"),
    get: unexpected("repos.get"),
    require: unexpected("repos.require"),
    getMany: unexpected("repos.getMany"),
    recordEnrichFailures: unexpected("repos.recordEnrichFailures"),
    sweepable: unexpected("repos.sweepable"),
    lease: unexpected("repos.lease"),
    settleFailures: unexpected("repos.settleFailures"),
  },
  stars: {
    upsert: unexpected("stars.upsert"),
    applySnapshot: unexpected("stars.applySnapshot"),
    list: unexpected("stars.list"),
    library: unexpected("stars.library"),
    page: unexpected("stars.page"),
    enrichment: unexpected("stars.enrichment"),
  },
  search: {
    hybrid: unexpected("search.hybrid"),
    matchesAsPrefix: unexpected("search.matchesAsPrefix"),
    nearNames: unexpected("search.nearNames"),
  },
  syncRequests: {
    get: unexpected("syncRequests.get"),
    claim: unexpected("syncRequests.claim"),
    ahead: unexpected("syncRequests.ahead"),
    schedule: unexpected("syncRequests.schedule"),
    settle: unexpected("syncRequests.settle"),
    prune: unexpected("syncRequests.prune"),
  },
  rateLines: {
    wait: unexpected("rateLines.wait"),
    reserve: unexpected("rateLines.reserve"),
    release: unexpected("rateLines.release"),
    prune: unexpected("rateLines.prune"),
  },
  usage: {
    increment: unexpected("usage.increment"),
    get: unexpected("usage.get"),
  },
  knowledge: {
    capture: unexpected("knowledge.capture"),
    prepareBatch: unexpected("knowledge.prepareBatch"),
    submittedBatch: unexpected("knowledge.submittedBatch"),
    openBatches: unexpected("knowledge.openBatches")(),
    extendBatch: unexpected("knowledge.extendBatch"),
    closeBatch: unexpected("knowledge.closeBatch"),
    dropBatch: unexpected("knowledge.dropBatch"),
    moveLease: unexpected("knowledge.moveLease"),
    claimPrefill: unexpected("knowledge.claimPrefill"),
    heartbeatPrefill: unexpected("knowledge.heartbeatPrefill"),
    releasePrefill: unexpected("knowledge.releasePrefill"),
    recordFailed: unexpected("knowledge.recordFailed"),
    mint: unexpected("knowledge.mint"),
    labels: unexpected("knowledge.labels"),
    project: unexpected("knowledge.project"),
    stale: unexpected("knowledge.stale"),
    count: unexpected("knowledge.count")(),
    countAtoms: unexpected("knowledge.countAtoms")(),
    allocate: unexpected("knowledge.allocate"),
    revision: unexpected("knowledge.revision")(),
    decisions: unexpected("knowledge.decisions")(),
    rules: unexpected("knowledge.rules")(),
    decide: unexpected("knowledge.decide"),
    subjects: unexpected("knowledge.subjects"),
    minted: unexpected("knowledge.minted"),
    reach: unexpected("knowledge.reach"),
    examples: unexpected("knowledge.examples"),
    floor: unexpected("knowledge.floor")(),
    variants: unexpected("knowledge.variants")(),
  },
  // Every procedure that answers repos reads their atoms, so a fake repo holds none unless a test says otherwise.
  facets: {
    held: () => Effect.succeed(new Map()),
    matching: () => Effect.succeed({ atoms: new Map(), labels: {} }),
    lookup: unexpected("facets.lookup"),
  },
} satisfies Db.Db["Service"];

export const makeDb = (overrides: Overrides = {}): Db.Db["Service"] =>
  Db.Db.of({
    accounts: { ...defaults.accounts, ...overrides.accounts },
    repos: { ...defaults.repos, ...overrides.repos },
    stars: { ...defaults.stars, ...overrides.stars },
    search: { ...defaults.search, ...overrides.search },
    syncRequests: { ...defaults.syncRequests, ...overrides.syncRequests },
    rateLines: { ...defaults.rateLines, ...overrides.rateLines },
    usage: { ...defaults.usage, ...overrides.usage },
    knowledge: { ...defaults.knowledge, ...overrides.knowledge },
    facets: { ...defaults.facets, ...overrides.facets },
  });

// The reservation rule of the rate_lines upsert, kept in a map, for a fake database behind procedures that meter.
export const memoryRateLines = (): Pick<Db.Db["Service"]["rateLines"], "reserve"> => {
  const busyUntil = new Map<Db.LineKey, number>();
  return {
    reserve: ({ line, at, cost, tolerance, maxWait, force }) =>
      Effect.sync(() => {
        const now = DateTime.toEpochMillis(at);
        const from = Math.max(busyUntil.get(line) ?? now, now);
        const startsAt = Math.max(now, from - Duration.toMillis(tolerance));
        if (!force && startsAt > now + Duration.toMillis(maxWait)) return Option.none();
        const endsAt = from + Duration.toMillis(cost);
        busyUntil.set(line, endsAt);
        return Option.some({
          line,
          cost,
          startsAt: DateTime.makeUnsafe(startsAt),
          endsAt: DateTime.makeUnsafe(endsAt),
          generation: 1,
          released: 0,
        });
      }),
  };
};
