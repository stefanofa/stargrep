import * as Schema from "effect/Schema";
import { MetricId } from "./metric-registry.ts";
import * as Vocabulary from "./vocabulary.ts";

const PlannedKind = Schema.Literals(Vocabulary.plannedKinds);

const Day = Schema.DateTimeUtcFromString.annotate({ description: "A date as YYYY-MM-DD." });

export const MetricBound = Schema.Struct({
  metric: MetricId,
  op: Schema.Literals(["gt", "gte", "lt", "lte"]),
  value: Schema.Finite,
});
export type MetricBound = typeof MetricBound.Type;

export const Filters = Schema.Struct({
  languages: Schema.Array(Schema.String).annotate({
    description: "GitHub language names, matched against a repo's language and topics.",
  }),
  kinds: Schema.Array(PlannedKind),
  licenses: Schema.Array(Schema.String).annotate({ description: "SPDX license identifiers, such as MIT." }),
  archived: Schema.NullOr(Schema.Boolean),
  starredAfter: Schema.NullOr(Day),
  starredBefore: Schema.NullOr(Day).annotate({ description: "Exclusive: stars before this day." }),
  metrics: Schema.Array(MetricBound),
});
export type Filters = typeof Filters.Type;

export const StatedLanguage = Schema.Struct({
  language: Schema.String.annotate({ description: "The GitHub language name, such as Python." }),
  said: Schema.String.annotate({ description: "The words in the query that name the language, copied as written." }),
});
export type StatedLanguage = typeof StatedLanguage.Type;

const PlannerFilters = Schema.Struct({ ...Filters.fields, languages: Schema.Array(StatedLanguage) });
export type PlannerFilters = typeof PlannerFilters.Type;

export const Ranking = Schema.Union([
  Schema.TaggedStruct("relevance", {}),
  Schema.TaggedStruct("metric", { metric: MetricId, direction: Schema.Literals(["highest", "lowest"]) }),
]);
export type Ranking = typeof Ranking.Type;

export const PlannerOutput = Schema.Struct({
  semanticText: Schema.NonEmptyString,
  filters: PlannerFilters,
  ranking: Ranking,
});
export type PlannerOutput = typeof PlannerOutput.Type;

export const noFilters = {
  languages: [],
  kinds: [],
  licenses: [],
  archived: null,
  starredAfter: null,
  starredBefore: null,
  metrics: [],
} as const satisfies Filters;

export const QueryPlan = Schema.Struct({
  ...PlannerOutput.fields,
  filters: Filters,
  textQuery: Schema.String,
  exactName: Schema.NullOr(Schema.String),
});
export type QueryPlan = typeof QueryPlan.Type;

export type QueryKind = "name" | "keywords" | "sentence";

const maxKeywordWords = 2;
const ownerAndName = /^[\w.-]+\/[\w.-]+$/;
const keywordWord = /^[a-z][a-z0-9+#._-]*$/i;

export const normalize = (query: string): string => query.trim().replace(/\s+/g, " ");

export const queryKind = (query: string): QueryKind => {
  if (ownerAndName.test(query)) return "name";
  const words = query.split(" ");
  if (words.length > maxKeywordWords || Vocabulary.mentionsFilter(query)) return "sentence";
  if (!words.every((word) => keywordWord.test(word) && !Vocabulary.isConnective(word))) return "sentence";
  return words.length === 1 ? "name" : "keywords";
};

export const asTyped = (query: string, kind: QueryKind): QueryPlan => ({
  semanticText: query,
  textQuery: query,
  exactName: kind === "name" ? query : null,
  filters: noFilters,
  ranking: { _tag: "relevance" },
});

export const fromPlannerOutput = (query: string, output: PlannerOutput): QueryPlan => ({
  ...output,
  filters: {
    ...output.filters,
    languages: output.filters.languages
      .filter((stated) => Vocabulary.namesLanguage(query, stated))
      .map((stated) => stated.language),
    kinds: Vocabulary.restrictsKind(query) ? output.filters.kinds : [],
  },
  textQuery: query,
  exactName: null,
});
