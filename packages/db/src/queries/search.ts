import type { GitHubAccountId } from "@stargrep/github/schemas";
import { type AtomRole, type ClosedAtom, everything, type Selection } from "@stargrep/knowledge/atom";
import { SubjectId } from "@stargrep/knowledge/ids";
import type { LabelKey } from "@stargrep/knowledge/label-key";
import { and, eq, isNull, sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { type Embedding, type EmbeddingModelId, type EmbeddingModelMismatch, requireModel } from "../embedding.ts";
import { type DbQueryFailed, DbRowInvalid } from "../errors.ts";
import * as Postgres from "../postgres.ts";
import { resultRows, rowsDecoder } from "../rows.ts";
import { repos, stars } from "../schema.ts";
import { Repo } from "./repos.ts";
import { hybridQuery, nearNamesQuery } from "./search-statement.ts";

export const MetricFamily = Schema.Literals([
  "stars",
  "forks",
  "commits",
  "active_contributors",
  "new_contributors",
  "merged_pull_requests",
  "closed_issues",
  "releases",
]);
export type MetricFamily = typeof MetricFamily.Type;

export const MetricVariant = Schema.Literals(["total", "change_30d", "change_90d", "growth_90d"]);
export type MetricVariant = typeof MetricVariant.Type;

export interface SearchMetric {
  readonly id: string;
  readonly family: MetricFamily;
  readonly variant: MetricVariant;
}

export interface MetricBound {
  readonly metric: string;
  readonly op: "gt" | "gte" | "lt" | "lte";
  readonly value: number;
}

export interface MetricRanking {
  readonly metric: string;
  readonly direction: "highest" | "lowest";
}

export interface SearchFilters {
  readonly archived: boolean | null;
  readonly starredAfter: DateTime.Utc | null;
  readonly starredBefore: DateTime.Utc | null;
  readonly metrics: ReadonlyArray<MetricBound>;
}

export const noFilters: SearchFilters = { archived: null, starredAfter: null, starredBefore: null, metrics: [] };

// filter keeps only matching repos, exclude drops them, and boost ranks matching candidates higher without dropping any.
export type GroupMode = "filter" | "exclude" | "boost";

// A group the query's words stated: closed atoms the compiler resolved, ORed.
export interface ClosedGroup {
  readonly _tag: "Closed";
  readonly mode: GroupMode;
  readonly any: readonly [ClosedAtom, ...Array<ClosedAtom>];
}

// A group of label keys, ORed, each reached through every role in roles. It applies only when every key names exactly
// one accepted public subject, which knowledge_key_meanings decides inside the statement.
export interface SubjectGroup {
  readonly _tag: "Subject";
  readonly mode: GroupMode;
  readonly roles: readonly [AtomRole, ...Array<AtomRole>];
  readonly keys: readonly [LabelKey, ...Array<LabelKey>];
}

export type StatedGroup = ClosedGroup | SubjectGroup;

export interface AtomQuery {
  // The caller's selection, which always filters.
  readonly explicit: Selection;
  readonly stated: ReadonlyArray<StatedGroup>;
}

export const noAtoms: AtomQuery = { explicit: everything, stated: [] };

export interface SearchScope {
  readonly kind: "stars";
  readonly accountId: GitHubAccountId;
}

export interface HybridSearch {
  readonly scope: SearchScope;
  readonly text: string;
  // Null searches full text alone.
  readonly embedding: Embedding | null;
  readonly maxDistance: number;
  readonly limit: number;
  readonly name: string | null;
  readonly metrics: ReadonlyArray<SearchMetric>;
  readonly filters: SearchFilters;
  readonly atoms: AtomQuery;
  readonly rankBy: MetricRanking | null;
}

const SearchHit = Schema.Struct({
  repo: Repo,
  nameMatch: Schema.Boolean,
  textRank: Schema.NullOr(Schema.Int),
  vectorRank: Schema.NullOr(Schema.Int),
  score: Schema.Finite,
  metrics: Schema.Array(Schema.NullOr(Schema.Finite)),
});
export type SearchHit = typeof SearchHit.Type;

// What SQL made of the atoms. stated has one entry per stated group: for a subject group, the subject each key named,
// in key order, or null when the group did not resolve, and nothing for a closed group. labels names every subject
// listed there and every explicit subject. unavailable lists the explicit subjects that are unknown, private, or
// rejected.
const Resolution = Schema.Struct({
  stated: Schema.Array(Schema.NullOr(Schema.Array(SubjectId))),
  labels: Schema.Record(Schema.String, Schema.String),
  unavailable: Schema.Array(SubjectId),
});
export type Resolution = typeof Resolution.Type;

export interface Hybrid {
  readonly hits: ReadonlyArray<SearchHit>;
  readonly resolution: Resolution;
}

export interface PrefixSearch {
  readonly scope: SearchScope;
  readonly text: string;
}

export interface NameSearch {
  readonly scope: SearchScope;
  readonly text: string;
  // The caller's selection, which always filters.
  readonly explicit: Selection;
  readonly limit: number;
}

export interface Queries {
  readonly hybrid: (
    search: HybridSearch,
  ) => Effect.Effect<Hybrid, DbQueryFailed | DbRowInvalid | EmbeddingModelMismatch>;
  readonly matchesAsPrefix: (search: PrefixSearch) => Effect.Effect<boolean, DbQueryFailed>;
  // The account's repos one edit at most from the text with its letters and digits run together: the name run
  // together, one part of the name, or the owner and name run together. Only repos the caller's selection keeps,
  // shortest names first.
  readonly nearNames: (search: NameSearch) => Effect.Effect<ReadonlyArray<Repo>, DbQueryFailed | DbRowInvalid>;
}

const decodeHits = rowsDecoder(SearchHit);
const decodeRepos = rowsDecoder(Schema.Struct({ repo: Repo }));

// Words keep only letters and digits, so the text can never be tsquery syntax. The last word matches as a prefix.
const prefixQuery = (text: string) => {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9]/g, ""))
    .filter((word) => word !== "");
  return words.length === 0
    ? null
    : words.map((word, index) => (index === words.length - 1 ? `${word}:*` : word)).join(" & ");
};

// The label keys that name an accepted public subject, as one isolate last read them.
export interface AcceptedKeys {
  readonly keys: ReadonlySet<string>;
  readonly readAt: number;
}

// A subject accepted since the last read applies to stated words within this long.
export const acceptedKeysTtl = Duration.minutes(5);

const decodeKeys = rowsDecoder(Schema.Struct({ key: Schema.String }));
const noKeys: ReadonlySet<string> = new Set();

export const make = Effect.fn("Db.search.make")(function* (
  configuredModel: EmbeddingModelId,
  acceptedKeys: Ref.Ref<Option.Option<AcceptedKeys>>,
) {
  const { run } = yield* Postgres.Postgres;
  const decodeResolution = Schema.decodeUnknownEffect(Resolution);

  // Every key that names exactly one accepted public subject, the rule knowledge_key_meanings applies, so an ambiguous
  // key never reaches the statement.
  const accepted = Effect.fnUntraced(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(acceptedKeys);
    if (Option.isSome(cached) && now - cached.value.readAt < Duration.toMillis(acceptedKeysTtl)) {
      return cached.value.keys;
    }
    const rows = yield* run("search.acceptedKeys", (db) =>
      db.execute(sql`select l.key from knowledge_labels l
        left join subject_canonical c on c.origin_id = l.subject_id
        join subjects s on s.id = coalesce(c.canonical_id, l.subject_id) and s.status = 'accepted'
        where l.namespace = 'public'
        group by l.key
        having count(distinct s.id) = 1`),
    ).pipe(Effect.flatMap((result) => decodeKeys("search.acceptedKeys")(resultRows(result))));
    const keys: ReadonlySet<string> = new Set(rows.map(({ key }) => key));
    yield* Ref.set(acceptedKeys, Option.some({ keys, readAt: now }));
    return keys;
  });

  return {
    hybrid: Effect.fnUntraced(function* (search: HybridSearch) {
      const vector = search.embedding === null ? null : yield* requireModel(configuredModel, search.embedding);
      const keys = search.atoms.stated.some((group) => group._tag === "Subject") ? yield* accepted() : noKeys;
      const rows = yield* run("search.hybrid", (db) => hybridQuery(db, search, vector, configuredModel, keys));
      const resolution = yield* decodeResolution(rows[0]?.envelope).pipe(
        Effect.mapError(() => new DbRowInvalid({ operation: "search.hybrid", column: "envelope" })),
      );
      const hits = yield* decodeHits("search.hybrid")(rows.filter((row) => row.repo !== null));
      return { hits, resolution } satisfies Hybrid;
    }),
    matchesAsPrefix: ({ scope, text }) => {
      const query = prefixQuery(text);
      if (query === null) return Effect.succeed(false);
      return run("search.matchesAsPrefix", (db) =>
        db
          .select({ id: stars.repoId })
          .from(stars)
          .innerJoin(repos, eq(repos.id, stars.repoId))
          .where(
            and(
              eq(stars.accountId, scope.accountId),
              isNull(stars.unstarredAt),
              sql`${repos.search} @@ to_tsquery('english', ${query})`,
            ),
          )
          .limit(1),
      ).pipe(Effect.map((rows) => rows.length > 0));
    },
    nearNames: ({ text, ...search }) => {
      const word = text.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (word === "") return Effect.succeed([]);
      return run("search.nearNames", (db) => nearNamesQuery(db, word, search)).pipe(
        Effect.flatMap(decodeRepos("search.nearNames")),
        Effect.map((rows) => rows.map((row) => row.repo)),
      );
    },
  } satisfies Queries;
});
