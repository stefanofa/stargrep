import type * as Db from "@stargrep/db";
import * as Schema from "effect/Schema";

const nouns: Readonly<Record<Db.MetricFamily, string>> = {
  stars: "stars",
  forks: "forks",
  commits: "commits",
  active_contributors: "active contributors",
  new_contributors: "new contributors",
  merged_pull_requests: "merged pull requests",
  closed_issues: "closed issues",
  releases: "releases",
};

export type MetricId =
  | Db.MetricFamily
  | `${Db.MetricFamily}_30d`
  | `${Db.MetricFamily}_90d`
  | `${Db.MetricFamily}_growth_90d`;

export interface Metric extends Db.SearchMetric {
  readonly id: MetricId;
  readonly description: string;
  readonly format: (value: number) => string;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const signed = (value: number) => `${value > 0 ? "+" : ""}${compact.format(value)}`;
const percent = (value: number) => `${value > 0 ? "+" : ""}${Math.round(value * 100)}%`;

const familyMetrics = (family: Db.MetricFamily): ReadonlyArray<Metric> => {
  const noun = nouns[family];
  return [
    {
      id: family,
      family,
      variant: "total",
      description: `Total ${noun}.`,
      format: (value) => `${compact.format(value)} ${noun}`,
    },
    {
      id: `${family}_30d`,
      family,
      variant: "change_30d",
      description: `Change in ${noun} over 30 days.`,
      format: (value) => `${signed(value)} ${noun} in 30 days`,
    },
    {
      id: `${family}_90d`,
      family,
      variant: "change_90d",
      description: `Change in ${noun} over 90 days.`,
      format: (value) => `${signed(value)} ${noun} in 90 days`,
    },
    {
      id: `${family}_growth_90d`,
      family,
      variant: "growth_90d",
      description: `Growth of ${noun} over 90 days as a fraction, 0.38 is +38%.`,
      format: (value) => `${percent(value)} ${noun} in 90 days`,
    },
  ];
};

export const registry = Object.fromEntries(
  (Object.keys(nouns) as ReadonlyArray<Db.MetricFamily>).flatMap(familyMetrics).map((metric) => [metric.id, metric]),
) as Readonly<Record<MetricId, Metric>>;

export const MetricId = Schema.Literals(Object.values(registry).map((metric) => metric.id)).annotate({
  identifier: "MetricId",
});
