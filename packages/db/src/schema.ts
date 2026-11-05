import { type SQL, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  halfvec,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.ts";
import { embeddingDimensions } from "./embedding.ts";

const githubId = (name: string) => bigint(name, { mode: "number" });
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const accountType = pgEnum("account_type", ["user", "org"]);
export const starSource = pgEnum("star_source", ["gharchive", "api"]);
export const followSource = pgEnum("follow_source", ["github", "stargrep"]);
export const collectionKind = pgEnum("collection_kind", ["user", "editorial"]);
export const searchScope = pgEnum("search_scope", ["stars", "network", "global"]);
export const syncRequestOutcome = pgEnum("sync_request_outcome", ["pending", "failed"]);

export const embeddingSettings = pgTable(
  "embedding_settings",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
  },
  () => [check("embedding_settings_one_row", sql`singleton`)],
);

export const githubAccounts = pgTable(
  "github_accounts",
  {
    id: githubId("id").primaryKey(),
    type: accountType("type").notNull(),
    login: text("login").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    followers: integer("followers"),
    publicRepos: integer("public_repos"),
    ownedRepoStars: integer("owned_repo_stars"),
    claimedBy: text("claimed_by").references(() => user.id, { onDelete: "set null" }),
    starredCount: integer("starred_count"),
    starsEtag: text("stars_etag"),
    starsSyncedAt: time("stars_synced_at"),
    starsFullSyncedAt: time("stars_full_synced_at"),
  },
  (table) => [uniqueIndex("github_accounts_claimed_by_key").on(table.claimedBy)],
);

export const repos = pgTable(
  "repos",
  {
    id: githubId("id").primaryKey(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    nodeId: text("node_id"),
    description: text("description"),
    topics: jsonb("topics").notNull().default([]),
    language: text("language"),
    license: text("license"),
    homepage: text("homepage"),
    kind: text("kind"),
    createdAt: time("created_at"),
    pushedAt: time("pushed_at"),
    archived: boolean("archived").notNull().default(false),
    readmeOid: text("readme_oid"),
    summary: text("summary"),
    summaryReadmeOid: text("summary_readme_oid"),
    keywords: jsonb("keywords").notNull().default([]),
    embedding: halfvec("embedding", { dimensions: embeddingDimensions }),
    embeddingModel: text("embedding_model"),
    enrichFailures: integer("enrich_failures").notNull().default(0),
    enrichFailedAt: time("enrich_failed_at"),
    search: tsvector("search")
      .notNull()
      .generatedAlwaysAs(
        (): SQL => sql`
          setweight(to_tsvector('english', ${repos.owner} || ' ' || ${repos.name}), 'A') ||
          setweight(to_tsvector('english', ${repos.topics}), 'A') ||
          setweight(to_tsvector('english', coalesce(${repos.description}, '')), 'B') ||
          setweight(to_tsvector('english', ${repos.keywords}), 'B') ||
          setweight(to_tsvector('english', coalesce(${repos.summary}, '')), 'C')`,
      ),
  },
  (table) => [
    index("repos_search_idx").using("gin", table.search),
    index("repos_pending_enrichment_idx")
      .on(table.enrichFailedAt, table.id)
      .where(
        sql`${table.summary} is null or ${table.summaryReadmeOid} is distinct from ${table.readmeOid} or ${table.embeddingModel} is null`,
      ),
  ],
);

export const repoMetrics = pgTable("repo_metrics", {
  repoId: githubId("repo_id")
    .primaryKey()
    .references(() => repos.id, { onDelete: "cascade" }),
  stars: integer("stars"),
  stars30d: integer("stars_30d"),
  stars90d: integer("stars_90d"),
  forks: integer("forks"),
  forks30d: integer("forks_30d"),
  forks90d: integer("forks_90d"),
  commits: integer("commits"),
  commits30d: integer("commits_30d"),
  commits90d: integer("commits_90d"),
  activeContributors: integer("active_contributors"),
  activeContributors30d: integer("active_contributors_30d"),
  activeContributors90d: integer("active_contributors_90d"),
  newContributors: integer("new_contributors"),
  newContributors30d: integer("new_contributors_30d"),
  newContributors90d: integer("new_contributors_90d"),
  mergedPullRequests: integer("merged_pull_requests"),
  mergedPullRequests30d: integer("merged_pull_requests_30d"),
  mergedPullRequests90d: integer("merged_pull_requests_90d"),
  closedIssues: integer("closed_issues"),
  closedIssues30d: integer("closed_issues_30d"),
  closedIssues90d: integer("closed_issues_90d"),
  releases: integer("releases"),
  releases30d: integer("releases_30d"),
  releases90d: integer("releases_90d"),
  refreshedAt: time("refreshed_at").notNull(),
});

export const stars = pgTable(
  "stars",
  {
    accountId: githubId("account_id")
      .notNull()
      .references(() => githubAccounts.id, { onDelete: "cascade" }),
    repoId: githubId("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    starredAt: time("starred_at").notNull(),
    unstarredAt: time("unstarred_at"),
    observedAt: time("observed_at").notNull(),
    source: starSource("source").notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.repoId] })],
);

export const follows = pgTable(
  "follows",
  {
    followerId: githubId("follower_id")
      .notNull()
      .references(() => githubAccounts.id, { onDelete: "cascade" }),
    followeeId: githubId("followee_id")
      .notNull()
      .references(() => githubAccounts.id, { onDelete: "cascade" }),
    source: followSource("source").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.followerId, table.followeeId] })],
);

export const collections = pgTable(
  "collections",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    ownerId: githubId("owner_id").references(() => githubAccounts.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    kind: collectionKind("kind").notNull(),
  },
  (table) => [unique("collections_owner_slug_key").on(table.ownerId, table.slug).nullsNotDistinct()],
);

export const collectionItems = pgTable(
  "collection_items",
  {
    collectionId: bigint("collection_id", { mode: "number" })
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    repoId: githubId("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    note: text("note"),
    position: integer("position").notNull(),
  },
  (table) => [primaryKey({ columns: [table.collectionId, table.repoId] })],
);

export const syncRequests = pgTable(
  "sync_requests",
  {
    login: text("login").primaryKey(),
    requestedAt: time("requested_at").notNull(),
    outcome: syncRequestOutcome("outcome").notNull(),
  },
  (table) => [index("sync_requests_requested_at_idx").on(table.requestedAt)],
);

export const searchEvents = pgTable("search_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  time: time("time").notNull().defaultNow(),
  scope: searchScope("scope").notNull(),
  query: text("query").notNull(),
  resultCount: integer("result_count").notNull(),
  clickedRepoId: githubId("clicked_repo_id").references(() => repos.id, { onDelete: "set null" }),
});

export const apiUsage = pgTable(
  "api_usage",
  {
    key: text("key").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    counts: jsonb("counts").notNull().default({}),
  },
  (table) => [primaryKey({ columns: [table.key, table.day] })],
);
