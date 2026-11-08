import * as Effect from "effect/Effect";
import * as Db from "../src/db.ts";

export { accountRow, repo } from "./fixtures.ts";

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
    saveSummary: unexpected("repos.saveSummary"),
    saveEmbedding: unexpected("repos.saveEmbedding"),
    saveIcon: unexpected("repos.saveIcon"),
    saveOwners: unexpected("repos.saveOwners"),
    dueIcons: unexpected("repos.dueIcons"),
    get: unexpected("repos.get"),
    require: unexpected("repos.require"),
    getMany: unexpected("repos.getMany"),
    recordEnrichFailures: unexpected("repos.recordEnrichFailures"),
    sweepable: unexpected("repos.sweepable"),
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
    adjust: unexpected("rateLines.adjust"),
    prune: unexpected("rateLines.prune"),
  },
  usage: {
    increment: unexpected("usage.increment"),
    get: unexpected("usage.get"),
  },
  knowledge: {
    capture: unexpected("knowledge.capture"),
    mint: unexpected("knowledge.mint"),
    labels: unexpected("knowledge.labels"),
    project: unexpected("knowledge.project"),
    stale: unexpected("knowledge.stale"),
    invalidate: unexpected("knowledge.invalidate"),
    count: unexpected("knowledge.count")(),
    allocate: unexpected("knowledge.allocate"),
    revision: unexpected("knowledge.revision")(),
    decisions: unexpected("knowledge.decisions")(),
    decide: unexpected("knowledge.decide"),
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
  });
