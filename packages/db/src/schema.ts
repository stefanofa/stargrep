import { summaryRecipe } from "@stargrep/ai/models";
import {
  type Dim,
  defaultRoles,
  KindId,
  LanguageId,
  LicenseId,
  PlatformId,
  type RoleId,
  roleIds,
  StatusId,
} from "@stargrep/knowledge/registry";
import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  halfvec,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.ts";
import { embeddingDimensions } from "./embedding.ts";

const githubId = (name: string) => bigint(name, { mode: "number" });
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

// The closed dimensions of packages/knowledge. The knowledge migration creates these types from registry.sql, and a
// registry change ships "alter type ... add value" (docs/knowledge.md).
// The registry lists at least one value for every closed dimension.
const closedEnum = <Id extends string>(name: string, ids: ReadonlyArray<Id>) =>
  pgEnum(name, ids as readonly [Id, ...Array<Id>]);
export const knowledgeKind = closedEnum("knowledge_kind", KindId.literals);
export const knowledgeLanguage = closedEnum("knowledge_language", LanguageId.literals);
export const knowledgeLicense = closedEnum("knowledge_license", LicenseId.literals);
export const knowledgePlatform = closedEnum("knowledge_platform", PlatformId.literals);
export const knowledgeStatus = closedEnum("knowledge_status", StatusId.literals);

// Where projection stores each role's atoms: one array per role and accepted dimension. A closed dimension's array is
// on repos, the row personal search already reads, and a subject array is in repo_facets.
export const atomColumns = {
  is: { kind: "kinds" },
  status: { status: "statuses" },
  written_in: { language: "written_in" },
  runs_on: { platform: "runs_on" },
  for: { language: "for_languages", platform: "for_platforms", subject: "for_subjects" },
  built_with: { language: "built_with_languages", platform: "built_with_platforms", subject: "built_with" },
  about: { subject: "about" },
  trait: { subject: "traits" },
  licensed: { license: "licensed" },
  tagged: { subject: "tagged" },
  alternative_to: { language: "alt_languages", platform: "alt_platforms", subject: "alternative_to" },
  replaced_by: { language: "replaced_by_languages", platform: "replaced_by_platforms", subject: "replaced_by" },
} as const satisfies { readonly [R in RoleId]: Partial<Record<Dim, string>> };

const columnsOf = (role: RoleId): Partial<Record<Dim, string>> => atomColumns[role];
const subjectColumn = (role: RoleId): ReadonlyArray<string> => {
  const column = columnsOf(role).subject;
  return column === undefined ? [] : [column];
};
const closedColumns = roleIds.flatMap((role) =>
  Object.entries(columnsOf(role)).flatMap(([dim, column]) => (dim === "subject" ? [] : [column])),
);
const subjectColumns = roleIds.flatMap(subjectColumn);

// Every subject a bare "subject:N" filter reaches, for its one GIN index. built_with is left out: only "with:" atoms
// reach it.
const membersExpression = defaultRoles("subject").flatMap(subjectColumn).join(" || ");

const namespaceOf = sql.raw(`case when owner_id is null then 'public' else 'user:' || owner_id end`);
const noNulls = (columns: ReadonlyArray<string>) =>
  sql.raw(columns.map((column) => `knowledge_no_nulls(${column})`).join(" and "));
const sha256Hex = (column: AnyPgColumn) => sql`${column} ~ '^[0-9a-f]{64}$'`;

export const accountType = pgEnum("account_type", ["user", "org"]);
export const starSource = pgEnum("star_source", ["gharchive", "api"]);
export const followSource = pgEnum("follow_source", ["github", "stargrep"]);
export const collectionKind = pgEnum("collection_kind", ["user", "editorial"]);
export const searchScope = pgEnum("search_scope", ["stars", "network", "global"]);
export const syncRequestOutcome = pgEnum("sync_request_outcome", ["pending", "failed", "missing", "claimed"]);
export const iconSource = pgEnum("icon_source", ["repo-file", "readme-image", "homepage"]);
export const iconPlate = pgEnum("icon_plate", ["none", "light", "dark"]);
// A repo's embedding is made from its saved summary, or from its metadata while the summary waits.
export const embeddingSource = pgEnum("embedding_source", ["summary", "metadata"]);

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
    // Unused, because ETags cannot tell a star sync anything. A cleanup migration drops it.
    starsEtag: text("stars_etag"),
    starsSyncedAt: time("stars_synced_at"),
    starsFullSyncedAt: time("stars_full_synced_at"),
  },
  (table) => [
    uniqueIndex("github_accounts_claimed_by_key").on(table.claimedBy),
    // Serves accountNamed's lookup and its order. Not unique, because an account renamed away keeps its old login.
    index("github_accounts_login_idx").on(sql`lower(${table.login})`, table.starsSyncedAt.desc().nullsLast(), table.id),
  ],
);

// A repo with this many of its own failed enrichments counts as failed, and the sweep stops sending it.
export const enrichFailureCap = 3;

interface EnrichmentColumns {
  readonly summary: AnyPgColumn;
  readonly summaryReadmeOid: AnyPgColumn;
  readonly readmeOid: AnyPgColumn;
  readonly summaryRecipe: AnyPgColumn;
  readonly summaryInputHash: AnyPgColumn;
  readonly inputHash: AnyPgColumn;
  readonly embeddingModel: AnyPgColumn;
  readonly embeddingStale: AnyPgColumn;
  readonly enrichFailures: AnyPgColumn;
  readonly goneAt: AnyPgColumn;
}

interface ListedColumns {
  readonly description: AnyPgColumn;
  readonly topics: AnyPgColumn;
}

interface MetadataColumns extends EnrichmentColumns, ListedColumns {
  readonly embedding: AnyPgColumn;
  readonly embeddingSource: AnyPgColumn;
}

interface PolicyColumns extends EnrichmentColumns, ListedColumns {
  readonly stars: AnyPgColumn;
  readonly userStarred: AnyPgColumn;
}

// A repo is read once it has a summary of its current README and an embedding of that summary.
export const unreadEnrichment = (table: EnrichmentColumns) =>
  sql<boolean>`(${table.summary} is null or ${table.summaryReadmeOid} is distinct from ${table.readmeOid} or ${table.embeddingModel} is null)`;

// Enrichment is due for an unread repo, for a read one whose summary an older recipe made or other prompt inputs, such
// as a new description or topic set, and for a read one whose embedding describes the summary its new one replaced.
// Such a repo stays read, and search keeps using it. A gone repo is never due. The recipe is a literal so the partial
// index can match this predicate.
export const pendingEnrichment = (table: EnrichmentColumns) =>
  sql<boolean>`(${unreadEnrichment(table)} or ${table.embeddingStale} or ${table.summaryRecipe} is distinct from ${sql.raw(String(summaryRecipe))} or ${table.summaryInputHash} is distinct from ${table.inputHash}) and ${table.goneAt} is null`;

// A new summary is due, not only an embedding: the repo has none, or its README, recipe, or prompt inputs moved on. A
// gone repo never is. Only this makes a repo worth a paid summary call.
export const summaryDue = (table: EnrichmentColumns) =>
  sql<boolean>`(${table.summary} is null or ${table.summaryReadmeOid} is distinct from ${table.readmeOid} or ${table.summaryRecipe} is distinct from ${sql.raw(String(summaryRecipe))} or ${table.summaryInputHash} is distinct from ${table.inputHash}) and ${table.goneAt} is null`;

// A description or a topic, the text a metadata embedding is made from besides the name.
const hasMetadata = (table: ListedColumns) =>
  sql<boolean>`(coalesce(${table.description}, '') <> '' or ${table.topics} <> '[]'::jsonb)`;

// A repo waiting for its summary gets an embedding of its metadata, so search can find it by meaning meanwhile. It is due
// when the repo has no embedding, or a metadata one its metadata has since moved past. A summary embedding, even a stale
// one, describes the repo better and is kept. A repo with neither a description nor topics is left to its summary,
// because its name alone sits near gibberish and full text already matches the name.
export const metadataEmbeddingDue = (table: MetadataColumns) =>
  sql<boolean>`${summaryDue(table)} and (${table.embedding} is null or (${table.embeddingSource} = 'metadata' and ${table.embeddingStale})) and ${hasMetadata(table)}`;

// Which repos get a paid summary. One with at least `stars` GitHub stars, one a signed-in user starred, or one with
// neither a description nor topics and at least `bareStars`, since only a summary lets search find that one by meaning.
// The sweep's partial index names both numbers, so a change to either ships with a migration that rebuilds it.
export const summaryPolicy = { stars: 200, bareStars: 50 } as const;

// A repo whose star count is unknown is wanted, so its first facts read can learn the count.
export const summaryWanted = (table: PolicyColumns) =>
  sql<boolean>`(${table.userStarred} or ${table.stars} is null or ${table.stars} >= ${sql.raw(String(summaryPolicy.stars))} or (${table.stars} >= ${sql.raw(String(summaryPolicy.bareStars))} and not ${hasMetadata(table)}))`;

// A summary is due but the policy does not want it, so the repo waits on its metadata embedding and the enrichment
// sweep leaves it alone until it gains stars or a signed-in user stars it.
export const summaryUnwanted = (table: PolicyColumns) =>
  sql<boolean>`${summaryDue(table)} and not ${summaryWanted(table)}`;

// The cap is a literal, not a parameter, so Postgres can match a query to the partial index on this predicate.
export const retryableEnrichment = (table: EnrichmentColumns) =>
  sql<boolean>`${pendingEnrichment(table)} and ${table.enrichFailures} < ${sql.raw(String(enrichFailureCap))}`;

// What the sweep may send: retryable enrichment that needs no summary, or whose summary the policy wants.
export const sweepableEnrichment = (table: PolicyColumns) =>
  sql<boolean>`${retryableEnrichment(table)} and (not (${summaryDue(table)}) or ${summaryWanted(table)})`;

interface SimilarColumns {
  readonly embedding: AnyPgColumn;
  readonly summary: AnyPgColumn;
  readonly goneAt: AnyPgColumn;
  readonly archived: AnyPgColumn;
}

// A repo the panel may suggest to an account that hasn't starred it: one with a summary to show and an embedding to
// rank by, that GitHub still serves and its owner hasn't archived. Triggers on repos keep similar_candidates to these,
// with the same test written in SQL, which a test holds to this one.
export const similarCandidate = (table: SimilarColumns) =>
  sql<boolean>`${table.embedding} is not null and ${table.summary} is not null and ${table.goneAt} is null and not ${table.archived}`;

// Every GIN index's pending list, in kB. The write that fills a list merges all of it into the index before it returns,
// and at the default 4 MB such a merge stalled a write for up to 12 s while a bulk import wrote repos.
const ginPendingListLimit = 256;

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
    createdAt: time("created_at"),
    pushedAt: time("pushed_at"),
    archived: boolean("archived").notNull().default(false),
    readmeOid: text("readme_oid"),
    summary: text("summary"),
    summaryReadmeOid: text("summary_readme_oid"),
    // The current recipe by default, so a summary that a Worker without recipes saves during a rollout counts as
    // current. A recipe bump changes this default in the migration that rebuilds both sweeps' partial indexes.
    summaryRecipe: integer("summary_recipe").notNull().default(summaryRecipe),
    keywords: jsonb("keywords").notNull().default([]),
    embedding: halfvec("embedding", { dimensions: embeddingDimensions }),
    embeddingModel: text("embedding_model"),
    // Which text the embedding was made from, when there is one.
    embeddingSource: embeddingSource("embedding_source").notNull().default("summary"),
    // A newer summary, or newer metadata for a metadata embedding, has replaced the text the embedding was made from.
    embeddingStale: boolean("embedding_stale").notNull().default(false),
    enrichFailures: integer("enrich_failures").notNull().default(0),
    enrichRetryAt: time("enrich_retry_at"),
    // The daily summary cap refused this repo's summary, and the repo has not been read since. The library counts it as
    // queued, so a page stops waiting on it, and saving the embedding clears it.
    summaryDeferred: boolean("summary_deferred").notNull().default(false),
    // GitHub's star count as a star list or a facts read last reported it, null until one has. repo_metrics keeps the
    // facts read's count for search. The summary policy reads this copy, because a partial index sees only this table.
    stars: integer("stars"),
    // A signed-in user starred the repo, so the summary policy wants it. An unstar leaves it set.
    userStarred: boolean("user_starred").notNull().default(false),
    // How many synced accounts star the repo now, which the summary order ranks by. A trigger on stars keeps it in the
    // statement that changes a star, so the sweep's index can hold the order.
    syncedStargazers: integer("synced_stargazers").notNull().default(0),
    iconKey: text("icon_key"),
    iconSource: iconSource("icon_source"),
    iconPlate: iconPlate("icon_plate"),
    iconSize: integer("icon_size"),
    iconCheckedAt: time("icon_checked_at"),
    ownerType: accountType("owner_type"),
    ownerAvatarUrl: text("owner_avatar_url"),
    // SHA-256 of the prompt inputs as saveFacts last saw them, and of the inputs the saved summary was made from.
    inputHash: text("input_hash"),
    summaryInputHash: text("summary_input_hash"),
    // The receipt the summary and the repo's atoms come from.
    receiptId: uuid("receipt_id"),
    // Set when GitHub stops serving the repo publicly. A gone repo has no atoms, and nothing recreates its facets row.
    goneAt: time("gone_at"),
    // The closed atoms, one array per role and closed dimension (atomColumns). Only projection writes them.
    kinds: knowledgeKind("kinds").array().notNull().default(sql`'{}'`),
    statuses: knowledgeStatus("statuses").array().notNull().default(sql`'{}'`),
    writtenIn: knowledgeLanguage("written_in").array().notNull().default(sql`'{}'`),
    runsOn: knowledgePlatform("runs_on").array().notNull().default(sql`'{}'`),
    forLanguages: knowledgeLanguage("for_languages").array().notNull().default(sql`'{}'`),
    forPlatforms: knowledgePlatform("for_platforms").array().notNull().default(sql`'{}'`),
    builtWithLanguages: knowledgeLanguage("built_with_languages").array().notNull().default(sql`'{}'`),
    builtWithPlatforms: knowledgePlatform("built_with_platforms").array().notNull().default(sql`'{}'`),
    licensed: knowledgeLicense("licensed").array().notNull().default(sql`'{}'`),
    altLanguages: knowledgeLanguage("alt_languages").array().notNull().default(sql`'{}'`),
    altPlatforms: knowledgePlatform("alt_platforms").array().notNull().default(sql`'{}'`),
    replacedByLanguages: knowledgeLanguage("replaced_by_languages").array().notNull().default(sql`'{}'`),
    replacedByPlatforms: knowledgePlatform("replaced_by_platforms").array().notNull().default(sql`'{}'`),
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
    index("repos_search_idx").using("gin", table.search).with({ gin_pending_list_limit: ginPendingListLimit }),
    // The sweep's, in summary order, so a sweep reads about as many entries as it sends however many repos wait.
    index("repos_sweep_order_idx")
      .on(
        sql`(${summaryDue(table)})`,
        table.userStarred.desc().nullsLast(),
        table.syncedStargazers.desc().nullsLast(),
        table.stars.desc().nullsLast(),
        table.id,
      )
      .where(sweepableEnrichment(table)),
    // The metadata sweep's, which holds every repo due a metadata embedding, the ones the policy holds back included.
    index("repos_metadata_sweep_idx").on(table.id).where(metadataEmbeddingDue(table)),
    check(
      "repos_icon_complete",
      sql`(${table.iconKey} is null) = (${table.iconSource} is null) and (${table.iconKey} is null) = (${table.iconPlate} is null) and (${table.iconKey} is null) = (${table.iconSize} is null)`,
    ),
    check("repos_input_hash_sha256", sha256Hex(table.inputHash)),
    check("repos_summary_input_hash_sha256", sha256Hex(table.summaryInputHash)),
    check(
      "repos_closed_atom_limits",
      sql`cardinality(${table.kinds}) <= 2 and cardinality(${table.statuses}) <= 2 and cardinality(${table.writtenIn}) <= 4 and cardinality(${table.runsOn}) <= 8 and cardinality(${table.forLanguages}) <= 8 and cardinality(${table.forPlatforms}) <= 8 and cardinality(${table.builtWithLanguages}) <= 4 and cardinality(${table.builtWithPlatforms}) <= 4 and cardinality(${table.licensed}) <= 1 and cardinality(${table.altLanguages}) <= 6 and cardinality(${table.altPlatforms}) <= 6 and cardinality(${table.replacedByLanguages}) <= 2 and cardinality(${table.replacedByPlatforms}) <= 2`,
    ),
    check("repos_closed_atom_no_nulls", noNulls(closedColumns)),
    foreignKey({
      name: "repos_receipt_fk",
      columns: [table.receiptId, table.id],
      foreignColumns: [receipts.id, receipts.repoId],
    }),
  ],
);

// The embedding of every similarCandidate repo, so the panel's nearest repos across stargrep come from an HNSW index on a
// table of their own. An index on repos would add the graph insert to every write that moves a repo's row, and a star
// moves its repo's stargazer count. Triggers on repos write a row here only when a repo's embedding, summary, gone time,
// or archived flag changes. `bun run --cwd packages/db backfill-similar` fills it once for the repos read before.
export const similarCandidates = pgTable(
  "similar_candidates",
  {
    repoId: githubId("repo_id")
      .primaryKey()
      .references(() => repos.id, { onDelete: "cascade" }),
    embedding: halfvec("embedding", { dimensions: embeddingDimensions }).notNull(),
  },
  (table) => [index("similar_candidates_embedding_idx").using("hnsw", table.embedding.op("halfvec_cosine_ops"))],
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
  (table) => [
    primaryKey({ columns: [table.accountId, table.repoId] }),
    // An account's current stars in page order, newest first and then by repo ID, so a page reads only its own rows.
    index("stars_page_idx")
      .on(table.accountId, table.starredAt.desc().nullsFirst(), table.repoId)
      .where(sql`${table.unstarredAt} is null`),
    // A repo's current stargazers, which the summary order counts.
    index("stars_repo_idx").on(table.repoId).where(sql`${table.unstarredAt} is null`),
  ],
);

// The people list: every account the public rule or the curated list picks, with its card computed from its synced
// stars. The nightly refresh rewrites it.
export const people = pgTable("people", {
  accountId: githubId("account_id")
    .primaryKey()
    .references(() => githubAccounts.id, { onDelete: "cascade" }),
  curated: boolean("curated").notNull(),
  stars: integer("stars").notNull(),
  lastStarredAt: time("last_starred_at").notNull(),
  // The top languages of the account's current stars, each with its share of them, most first.
  languages: jsonb("languages").notNull().default([]),
  // The topics most of the account's current stars carry, most first.
  topics: jsonb("topics").notNull().default([]),
  // The account's stars_synced_at when the refresh last read its stars, so it reads them again only after a sync.
  syncedAt: time("synced_at"),
});

// A copy of every listed person's current stars, keyed by repo, so a count of the stars an account shares with each
// person reads one entry per star of that account instead of every star of every person.
export const peopleStars = pgTable(
  "people_stars",
  {
    accountId: githubId("account_id")
      .notNull()
      .references(() => people.accountId, { onDelete: "cascade" }),
    repoId: githubId("repo_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.repoId] }),
    index("people_stars_repo_idx").on(table.repoId, table.accountId),
  ],
);

// Every GitHub topic of every repo GitHub still serves that is not archived, one row each, with the repo's kinds and name.
// Triggers on repos rewrite a repo's rows in the statement that changes any of them, so the nightly topics refresh reads
// narrow rows instead of the repos heap.
export const repoTopics = pgTable(
  "repo_topics",
  {
    repoId: githubId("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    kinds: knowledgeKind("kinds").array().notNull(),
    // The repo's name in lowercase letters and digits, so a refresh finds the repo named like its topic.
    nameKey: text("name_key").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.repoId, table.topic] }),
    index("repo_topics_topic_idx").on(table.topic, table.repoId),
  ],
);

// How a repo belongs to a topic. core is a repo for or about it, built one built with it, tagged one that only carries
// its tag, and home one that may be the topic's own repo, such as vercel/next.js for nextjs.
export const topicRole = pgEnum("topic_role", ["core", "built", "tagged", "home"]);

// Every repo of every topic that could get a page, with its role, as of the nightly refresh. A topic's search reads all
// of them, and its page lists the core and built ones.
export const topicRepos = pgTable(
  "topic_repos",
  {
    topic: text("topic").notNull(),
    repoId: githubId("repo_id").notNull(),
    role: topicRole("role").notNull(),
  },
  (table) => [primaryKey({ columns: [table.topic, table.repoId] })],
);

// One row per topic that gets a page, with what the page shows, as of the nightly refresh.
export const topics = pgTable("topics", {
  topic: text("topic").primaryKey(),
  // How many repos its search reads, and how many core repos enough synced developers star to rank.
  repos: integer("repos").notNull(),
  ranked: integer("ranked").notNull(),
  home: githubId("home"),
  // Repo IDs, most starred by synced developers first.
  core: jsonb("core").notNull().default([]),
  built: jsonb("built").notNull().default([]),
  // The gated topics whose core repos overlap its own most, closest first.
  related: jsonb("related").notNull().default([]),
  // The listed people who star the most of its core repos for how many they star, as [account ID, core stars] pairs.
  people: jsonb("people").notNull().default([]),
});

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
    // When a sent sync starts: requested_at, or the start of its turn in line. Null while the request is claimed and
    // not yet sent, and for a missing login.
    startsAt: time("starts_at"),
  },
  (table) => [index("sync_requests_requested_at_idx").on(table.requestedAt)],
);

// One row per user who asked for the monthly picks email. Nothing sends it yet, so the row count is the waitlist.
export const monthlyPicks = pgTable("monthly_picks", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  optedInAt: time("opted_in_at").notNull().defaultNow(),
});

// One row per rate line that core meters. A line is clear once the clock passes busy_until, the same as a line with no
// row.
export const rateLines = pgTable("rate_lines", {
  key: text("key").primaryKey(),
  busyUntil: time("busy_until").notNull(),
  // Milliseconds given back from the line in all, so a release can tell how far its reservation may have moved.
  releasedMs: doublePrecision("released_ms").notNull().default(0),
  // New each time the row is created, so a receipt from a line the prune deleted never releases into its successor.
  generation: bigint("generation", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
});

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

// Structured repo knowledge (docs/knowledge.md). Receipts and decisions are the sources of truth. Subjects, their
// labels, and the derived maps are the vocabulary, and repo_facets with the closed arrays on repos is the projection.
// queries/knowledge/ is the only writer. The knowledge migration adds the triggers, views, and functions that read
// and guard these tables.

export const receiptSource = pgEnum("receipt_source", ["model", "stand-in", "legacy"]);
export const batchState = pgEnum("batch_state", ["prepared", "submitted", "captured", "abandoned"]);
export const subjectStatus = pgEnum("subject_status", ["candidate", "accepted", "rejected"]);
export const decisionKind = pgEnum("decision_kind", [
  "create",
  "merge",
  "split",
  "rename",
  "alias",
  "parent",
  "expand",
  "keep_apart",
  "status",
  "link",
  "correct",
  "publish",
  "retire",
  "undo",
]);
export const closureVia = pgEnum("closure_via", ["split", "parent", "expand"]);

const revision = (name: string) => bigint(name, { mode: "number" });
const subjectId = (name: string) => bigint(name, { mode: "number" });
const subjectArray = (name: string) => bigint(name, { mode: "number" }).array().notNull().default(sql`'{}'`);

// One row per provider request of the prefill, written before the request is sent, so a crashed run resends the
// stored body byte for byte and finds the batch it already paid for.
export const extractionBatches = pgTable(
  "extraction_batches",
  {
    id: uuid("id").primaryKey(),
    adapter: text("adapter").notNull(),
    model: text("model").notNull(),
    recipe: integer("recipe").notNull(),
    // The Gateway idempotency key the request hashes to.
    requestKey: text("request_key").notNull().unique("extraction_batches_request_key_key"),
    // R2 key of the exact request body.
    requestObject: text("request_object").notNull(),
    providerBatchId: text("provider_batch_id"),
    // Item i of the request is repo_ids[i], built from input_hashes[i].
    repoIds: bigint("repo_ids", { mode: "number" }).array().notNull(),
    inputHashes: text("input_hashes").array().notNull(),
    state: batchState("state").notNull().default("prepared"),
    leaseUntil: time("lease_until").notNull(),
    // The manifest whose badly answered items this one asks again, as a second batch with its own key. Its own bad
    // answers are final.
    retryOf: uuid("retry_of").references((): AnyPgColumn => extractionBatches.id, { onDelete: "set null" }),
    // Items whose answer failed for good: the fallback's own bad answers, and failed CLI calls. A gate can count them
    // even when an answer to a repo's current input converged on a receipt it already had.
    failedRepoIds: bigint("failed_repo_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("extraction_batches_open_idx").on(table.createdAt).where(sql`${table.state} in ('prepared', 'submitted')`),
    check("extraction_batches_adapter_known", sql`${table.adapter} in ('gateway-batch', 'claude-code')`),
    check("extraction_batches_recipe_positive", sql`${table.recipe} > 0`),
    check("extraction_batches_size", sql`cardinality(${table.repoIds}) between 1 and 1000`),
    check("extraction_batches_items_paired", sql`cardinality(${table.repoIds}) = cardinality(${table.inputHashes})`),
    check("extraction_batches_no_nulls", noNulls(["repo_ids", "input_hashes"])),
    // A batch is submitted only once the provider has named it.
    check(
      "extraction_batches_named_when_submitted",
      sql`${table.state} = 'prepared' or ${table.adapter} = 'claude-code' or ${table.providerBatchId} is not null`,
    ),
  ],
);

// The one prefill driver that may run against this database. A driver claims the row, renews heartbeat_at while it
// runs, and deletes it when it stops. Another may take the row only once its heartbeat is stale, so two drivers never
// resume, drop, or pay for the same manifests, and a crashed driver blocks the next run for a minute at most.
export const prefillOwner = pgTable(
  "prefill_owner",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    owner: uuid("owner").notNull(),
    heartbeatAt: time("heartbeat_at").notNull(),
  },
  () => [check("prefill_owner_one_row", sql`singleton`)],
);

// The one star import driver that may run against this database, claimed and renewed the way prefill_owner is, so two
// drivers never read the same accounts on one token at once.
export const starImportOwner = pgTable(
  "star_import_owner",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    owner: uuid("owner").notNull(),
    heartbeatAt: time("heartbeat_at").notNull(),
  },
  () => [check("star_import_owner_one_row", sql`singleton`)],
);

// Where the icon backfill's one chain stands: the repo ID its next page reads after, or null when no chain runs. A page
// moves it from its own position to the next one before it sends anything, so a second copy of a page, or a second
// chain, finds the row moved or finished and stops.
export const iconBackfill = pgTable(
  "icon_backfill",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    after: githubId("after"),
  },
  () => [check("icon_backfill_one_row", sql`singleton`)],
);

// What one source said about one repo for one input, kept as it was. A trigger refuses edits except to the projection
// markers, and to batch_id and carried_from going null when the row they name expires.
export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey(),
    repoId: githubId("repo_id")
      .notNull()
      .references((): AnyPgColumn => repos.id, { onDelete: "cascade" }),
    source: receiptSource("source").notNull(),
    inputHash: text("input_hash").notNull(),
    recipe: integer("recipe").notNull(),
    model: text("model").notNull(),
    batchId: uuid("batch_id").references(() => extractionBatches.id, { onDelete: "set null" }),
    capturedAt: time("captured_at").notNull().defaultNow(),
    summary: text("summary").notNull(),
    keywords: jsonb("keywords").notNull(),
    // Decoded claims, each with ordinal, role, term, key, quote, and found.
    claims: jsonb("claims").notNull(),
    // Role to complete, invalid, or missing.
    lanes: jsonb("lanes").notNull(),
    // Items the decoder could not read, with bounded issue codes and no model text.
    dropped: jsonb("dropped").notNull().default([]),
    // Set when the answer had no facets list and capture copied the previous receipt's claims.
    carriedFrom: uuid("carried_from").references((): AnyPgColumn => receipts.id, { onDelete: "set null" }),
    rawKey: text("raw_key"),
    // Written only by projection.
    projectedRevision: revision("projected_revision"),
    verdicts: jsonb("verdicts"),
  },
  (table) => [
    // One answer per source, input, and recipe, so a retry or a resumed batch converges on the first one committed.
    unique("receipts_answer_key").on(table.repoId, table.source, table.inputHash, table.recipe),
    // Lets repos and repo_facets prove a receipt belongs to their repo.
    unique("receipts_id_repo_key").on(table.id, table.repoId),
    index("receipts_repo_idx").on(table.repoId, table.capturedAt.desc().nullsFirst()),
    index("receipts_batch_idx").on(table.batchId).where(sql`${table.batchId} is not null`),
    check("receipts_input_hash_sha256", sha256Hex(table.inputHash)),
    check("receipts_recipe_positive", sql`${table.recipe} > 0`),
    check("receipts_model_length", sql`length(${table.model}) between 1 and 120`),
    check("receipts_summary_present", sql`length(${table.summary}) > 0`),
    check("receipts_keywords_array", sql`jsonb_typeof(${table.keywords}) = 'array'`),
    check("receipts_claims_array", sql`jsonb_typeof(${table.claims}) = 'array'`),
    check("receipts_lanes_object", sql`jsonb_typeof(${table.lanes}) = 'object'`),
    check("receipts_dropped_array", sql`jsonb_typeof(${table.dropped}) = 'array'`),
    check("receipts_verdicts_array", sql`${table.verdicts} is null or jsonb_typeof(${table.verdicts}) = 'array'`),
  ],
);

// The curation log, one per namespace and append-only. Revisions are dense, assigned under the namespace's exclusive
// knowledge lock. A private log goes with its owner.
export const decisions = pgTable(
  "decisions",
  {
    // Null is the public log.
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull().generatedAlwaysAs(namespaceOf),
    revision: revision("revision").notNull(),
    kind: decisionKind("kind").notNull(),
    // The kind column repeats the payload's tag for indexing.
    payload: jsonb("payload").notNull(),
    undoes: revision("undoes"),
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    decidedAt: time("decided_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "decisions_pkey", columns: [table.namespace, table.revision] }),
    foreignKey({
      name: "decisions_undoes_fk",
      columns: [table.namespace, table.undoes],
      foreignColumns: [table.namespace, table.revision],
    }),
    index("decisions_kind_idx").on(table.namespace, table.kind, table.revision),
    check("decisions_revision_positive", sql`${table.revision} > 0`),
    check(
      "decisions_payload_tagged",
      sql`jsonb_typeof(${table.payload}) = 'object' and ${table.payload} ->> '_tag' is not null`,
    ),
    check("decisions_actor_length", sql`length(${table.actor}) between 1 and 80`),
    check("decisions_reason_length", sql`length(${table.reason}) between 1 and 1000`),
    check("decisions_undo_names_revision", sql`(${table.kind} = 'undo') = (${table.undoes} is not null)`),
    check("decisions_undoes_earlier", sql`${table.undoes} is null or ${table.undoes} < ${table.revision}`),
    // Pages are public, so a private log never publishes or retires.
    check("decisions_private_unpublished", sql`${table.ownerId} is null or ${table.kind} not in ('publish', 'retire')`),
  ],
);

// The open vocabulary, in immutable namespaces.
export const subjects = pgTable(
  "subjects",
  {
    id: subjectId("id").primaryKey().generatedByDefaultAsIdentity(),
    // Null is the public namespace. A private subject goes with its owner.
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    namespace: text("namespace").notNull().generatedAlwaysAs(namespaceOf),
    // The first surface form seen, until a Rename decision.
    label: text("label").notNull(),
    definition: text("definition"),
    status: subjectStatus("status").notNull().default("candidate"),
    // Distinct live public repos a filter on this subject matches, from the last knowledge_refresh_counts.
    repoCount: integer("repo_count").notNull().default(0),
    // A subject shows in chips, counts, lookups, profiles, and pages once a second repo holds it.
    listed: boolean("listed").notNull().generatedAlwaysAs(sql.raw("repo_count >= 2")),
    // The repo that is this subject's project. Set by a Link decision.
    repoId: githubId("repo_id").references((): AnyPgColumn => repos.id, { onDelete: "set null" }),
    // The receipt whose claim minted it, or the decision that created it.
    originReceiptId: uuid("origin_receipt_id").references(() => receipts.id, { onDelete: "set null" }),
    originRevision: revision("origin_revision"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    // Composite key for same-namespace foreign keys.
    unique("subjects_id_namespace_key").on(table.id, table.namespace),
    foreignKey({
      name: "subjects_origin_revision_fk",
      columns: [table.namespace, table.originRevision],
      foreignColumns: [decisions.namespace, decisions.revision],
    }).onDelete("cascade"),
    // One subject per linked repo. A second link means the two subjects should merge.
    uniqueIndex("subjects_repo_key").on(table.repoId).where(sql`${table.repoId} is not null`),
    index("subjects_status_idx").on(table.status, table.id),
    check("subjects_label_length", sql`length(${table.label}) between 1 and 120`),
    check("subjects_definition_length", sql`length(${table.definition}) <= 400`),
    check("subjects_repo_count_nonnegative", sql`${table.repoCount} >= 0`),
    // Receipts hold only public repos, so a private subject never cites one, and never links a public repo.
    check(
      "subjects_private_unlinked",
      sql`${table.ownerId} is null or (${table.originReceiptId} is null and ${table.repoId} is null)`,
    ),
  ],
);

// Label keys to subjects. Every claim with the same key resolves the same way. Resolution reads the knowledge_labels
// view, where a decision default outranks a minted one.
export const subjectLabels = pgTable(
  "subject_labels",
  {
    namespace: text("namespace").notNull(),
    // labelKey(term) from packages/knowledge.
    key: text("key").notNull(),
    subjectId: subjectId("subject_id").notNull(),
    isDefault: boolean("is_default").notNull(),
    // minted: written once by projection. decision: written by Create, Alias, Rename, or Split, removed by their undo.
    source: text("source").notNull(),
    revision: revision("revision"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "subject_labels_pkey", columns: [table.namespace, table.key, table.subjectId] }),
    // The knowledge migration makes this deferrable, so a mint can insert labels before their subjects.
    foreignKey({
      name: "subject_labels_subject_fk",
      columns: [table.subjectId, table.namespace],
      foreignColumns: [subjects.id, subjects.namespace],
    }).onDelete("cascade"),
    foreignKey({
      name: "subject_labels_revision_fk",
      columns: [table.namespace, table.revision],
      foreignColumns: [decisions.namespace, decisions.revision],
    }).onDelete("cascade"),
    // One default per key and per writer.
    uniqueIndex("subject_labels_decision_default_key")
      .on(table.namespace, table.key)
      .where(sql`${table.isDefault} and ${table.source} = 'decision'`),
    uniqueIndex("subject_labels_minted_default_key")
      .on(table.namespace, table.key)
      .where(sql`${table.isDefault} and ${table.source} = 'minted'`),
    index("subject_labels_subject_idx").on(table.subjectId),
    // Prefix lookup for lookups and chip autocomplete.
    index("subject_labels_prefix_idx").on(table.namespace, table.key.op("text_pattern_ops")),
    // A closed value's spelling is never a subject label.
    check(
      "subject_labels_key_check",
      sql`${table.key} = btrim(${table.key}) and length(${table.key}) between 1 and 80 and not knowledge_reserved_key(${table.key})`,
    ),
    check("subject_labels_source_known", sql`${table.source} in ('minted', 'decision')`),
    check("subject_labels_decision_revision", sql`(${table.source} = 'decision') = (${table.revision} is not null)`),
  ],
);

// Merged origins and their survivor, one hop. A subject with no row is canonical.
export const subjectCanonical = pgTable(
  "subject_canonical",
  {
    namespace: text("namespace").notNull(),
    originId: subjectId("origin_id").primaryKey(),
    canonicalId: subjectId("canonical_id").notNull(),
    revision: revision("revision").notNull(),
  },
  (table) => [
    foreignKey({
      name: "subject_canonical_origin_fk",
      columns: [table.originId, table.namespace],
      foreignColumns: [subjects.id, subjects.namespace],
    }).onDelete("cascade"),
    foreignKey({
      name: "subject_canonical_canonical_fk",
      columns: [table.canonicalId, table.namespace],
      foreignColumns: [subjects.id, subjects.namespace],
    }).onDelete("cascade"),
    foreignKey({
      name: "subject_canonical_revision_fk",
      columns: [table.namespace, table.revision],
      foreignColumns: [decisions.namespace, decisions.revision],
    }).onDelete("cascade"),
    index("subject_canonical_canonical_idx").on(table.canonicalId, table.originId),
    check("subject_canonical_distinct", sql`${table.originId} <> ${table.canonicalId}`),
  ],
);

// Split, Parent, and Expand descendants of canonical subjects. via is the weakest edge on the path.
export const subjectClosure = pgTable(
  "subject_closure",
  {
    namespace: text("namespace").notNull(),
    ancestorId: subjectId("ancestor_id").notNull(),
    descendantId: subjectId("descendant_id").notNull(),
    depth: smallint("depth").notNull(),
    via: closureVia("via").notNull(),
    revision: revision("revision").notNull(),
  },
  (table) => [
    primaryKey({ name: "subject_closure_pkey", columns: [table.ancestorId, table.descendantId] }),
    foreignKey({
      name: "subject_closure_ancestor_fk",
      columns: [table.ancestorId, table.namespace],
      foreignColumns: [subjects.id, subjects.namespace],
    }).onDelete("cascade"),
    foreignKey({
      name: "subject_closure_descendant_fk",
      columns: [table.descendantId, table.namespace],
      foreignColumns: [subjects.id, subjects.namespace],
    }).onDelete("cascade"),
    foreignKey({
      name: "subject_closure_revision_fk",
      columns: [table.namespace, table.revision],
      foreignColumns: [decisions.namespace, decisions.revision],
    }).onDelete("cascade"),
    index("subject_closure_descendant_idx").on(table.descendantId, table.ancestorId),
    check("subject_closure_depth", sql`${table.depth} between 1 and 3`),
    check("subject_closure_distinct", sql`${table.ancestorId} <> ${table.descendantId}`),
  ],
);

// The one rule for what a subject filter matches: a filter on canonical subject_id matches a repo whose array holds
// origin_id. comparison rows serve alternative_to and replaced_by, which widen through splits only. Search reads it by
// subject, and every count reads it by origin.
export const subjectMatches = pgTable(
  "subject_matches",
  {
    subjectId: subjectId("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    comparison: boolean("comparison").notNull(),
    originId: subjectId("origin_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ name: "subject_matches_pkey", columns: [table.subjectId, table.comparison, table.originId] }),
    index("subject_matches_origin_idx").on(table.originId, table.comparison, table.subjectId),
  ],
);

// Counts from the last nightly run, by the key a filter uses. For now one row per closed value's bare key, such as
// "lang:javascript", which counts TypeScript repos too. Subjects keep theirs in subjects.repo_count, which decides
// listing. A closed value no live repo matches has no row.
export const atomStats = pgTable(
  "atom_stats",
  {
    atom: text("atom").primaryKey(),
    repos: integer("repos").notNull(),
  },
  (table) => [check("atom_stats_repos_positive", sql`${table.repos} > 0`)],
);

// The subject half of the serving projection, one row per live repo. Subject arrays hold origin IDs, so a merge
// rewrites no row. Triggers mark the row stale when an input changes, and only projection clears it.
export const repoFacets = pgTable(
  "repo_facets",
  {
    repoId: githubId("repo_id")
      .primaryKey()
      .references((): AnyPgColumn => repos.id, { onDelete: "cascade" }),
    // The receipt this row and the repo's closed arrays project. Null for a repo projected from GitHub facts alone.
    receiptId: uuid("receipt_id"),
    // The decision revision the projection read.
    revision: revision("revision").notNull().default(0),
    stale: boolean("stale").notNull().default(true),
    projectedAt: time("projected_at"),
    forSubjects: subjectArray("for_subjects"),
    builtWith: subjectArray("built_with"),
    about: subjectArray("about"),
    traits: subjectArray("traits"),
    tagged: subjectArray("tagged"),
    alternativeTo: subjectArray("alternative_to"),
    replacedBy: subjectArray("replaced_by"),
    members: bigint("members", { mode: "number" }).array().notNull().generatedAlwaysAs(sql.raw(membersExpression)),
    // Label keys the projection looked up and found no label for. A new label for one marks the row stale.
    unresolvedKeys: text("unresolved_keys").array().notNull().default(sql`'{}'`),
  },
  (table) => [
    foreignKey({
      name: "repo_facets_receipt_fk",
      columns: [table.receiptId, table.repoId],
      foreignColumns: [receipts.id, receipts.repoId],
    }),
    index("repo_facets_members_idx").using("gin", table.members).with({ gin_pending_list_limit: ginPendingListLimit }),
    index("repo_facets_built_with_idx")
      .using("gin", table.builtWith)
      .with({ gin_pending_list_limit: ginPendingListLimit }),
    index("repo_facets_alternative_to_idx")
      .using("gin", table.alternativeTo)
      .with({ gin_pending_list_limit: ginPendingListLimit }),
    index("repo_facets_replaced_by_idx")
      .using("gin", table.replacedBy)
      .with({ gin_pending_list_limit: ginPendingListLimit }),
    index("repo_facets_unresolved_keys_idx")
      .using("gin", table.unresolvedKeys)
      .with({ gin_pending_list_limit: ginPendingListLimit }),
    // The projection sweep reads only stale rows.
    index("repo_facets_stale_idx").on(table.repoId).where(sql`${table.stale}`),
    check(
      "repo_facets_subject_limits",
      sql`cardinality(${table.forSubjects}) <= 16 and cardinality(${table.builtWith}) <= 8 and cardinality(${table.about}) <= 16 and cardinality(${table.traits}) <= 16 and cardinality(${table.tagged}) <= 20 and cardinality(${table.alternativeTo}) <= 8 and cardinality(${table.replacedBy}) <= 4`,
    ),
    check("repo_facets_unresolved_limit", sql`cardinality(${table.unresolvedKeys}) <= 64`),
    check("repo_facets_no_nulls", noNulls([...subjectColumns, "unresolved_keys"])),
  ],
);
