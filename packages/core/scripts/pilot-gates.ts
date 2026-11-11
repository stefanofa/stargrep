import { summaryRecipe } from "@stargrep/ai/models";
import type { Reasoning } from "@stargrep/ai/text-generation";
import { Claim, Lanes } from "@stargrep/knowledge/claims";
import * as Schema from "effect/Schema";

// What the pilot 2 gates read about each sampled repo, from the database alone, so a run killed with SIGKILL, which
// writes no report, still counts. $1 is the sample's repo IDs and $2 the recipe the pilot asked under.
export const sampleRows = `
  select r.id::float8 as id, r.owner, r.name, r.readme_oid is not null as "hasReadme",
    cardinality(r.kinds) > 0 as "hasKind", coalesce(cardinality(f.about), 0) > 0 as "hasAbout",
    c.lanes, c.claims, c.carried_from is not null as carried, c.captured_at::text as "capturedAt", c.model,
    exists (select 1 from extraction_batches b where b.retry_of is null and b.recipe = $2 and r.id = any(b.repo_ids))
      as asked,
    exists (select 1 from extraction_batches b where b.retry_of is not null and b.recipe = $2 and r.id = any(b.repo_ids))
      as retried,
    exists (select 1 from extraction_batches b where b.recipe = $2 and r.id = any(b.failed_repo_ids)) as failed,
    exists (select 1 from receipts l where l.repo_id = r.id and l.source = 'legacy') as legacy,
    array(select l.key from subject_labels l where l.subject_id = any(f.alternative_to)) as "altKeys"
  from repos r left join receipts c on c.id = r.receipt_id and c.source in ('model', 'stand-in')
    left join repo_facets f on f.repo_id = r.id
  where r.id = any($1::bigint[])`;

// Sampled repos that first-attempt manifests asked more than once about the same input under the recipe. Receipts are
// unique per repo, source, input, and recipe, so a second payment never shows as a second receipt. It shows here.
export const repeatedAsks = `
  select count(*)::int as repeated from (
    select u.repo_id from extraction_batches b, unnest(b.repo_ids, b.input_hashes) as u (repo_id, input_hash)
    where b.retry_of is null and b.recipe = $2 and u.repo_id = any($1::bigint[])
    group by u.repo_id, u.input_hash having count(*) > 1
  ) asked_twice`;

export const recipe = summaryRecipe;

export const decodeRepeated = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ repeated: Schema.Int })));

export const SampleRow = Schema.Struct({
  id: Schema.Int,
  owner: Schema.String,
  name: Schema.String,
  hasReadme: Schema.Boolean,
  hasKind: Schema.Boolean,
  hasAbout: Schema.Boolean,
  lanes: Schema.NullOr(Lanes),
  claims: Schema.NullOr(Schema.Array(Claim)),
  carried: Schema.NullOr(Schema.Boolean),
  capturedAt: Schema.NullOr(Schema.String),
  // The model that wrote the current answer, which tells a trial of another summary model from the default's run.
  model: Schema.NullOr(Schema.String),
  // A first-attempt manifest under the recipe asked this repo.
  asked: Schema.Boolean,
  // Its first batch answer was missing or did not decode, so a fallback batch asked it again.
  retried: Schema.Boolean,
  // Its answer failed for good: the fallback's too, or a failed CLI call.
  failed: Schema.Boolean,
  // It has a recipe 1 answer, kept as a legacy receipt.
  legacy: Schema.Boolean,
  altKeys: Schema.Array(Schema.String),
});
export type SampleRow = typeof SampleRow.Type;
export const decodeSampleRows = Schema.decodeUnknownEffect(Schema.Array(SampleRow));

// The decode gate over every repo the run asked, answered or not: the share whose first batch answer did not decode,
// and the repos that never got an answer that decodes, which a gate over answered repos alone would miss.
export const decodeGate = (rows: ReadonlyArray<SampleRow>) => {
  const asked = rows.filter((row) => row.asked);
  return {
    asked: asked.length,
    retried: asked.filter((row) => row.retried).length,
    failed: asked.filter((row) => row.failed).map((row) => row.id),
  };
};

// How many current answers each model wrote, most first.
export const answerModels = (rows: ReadonlyArray<SampleRow>) => {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.model !== null) counts.set(row.model, (counts.get(row.model) ?? 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
};

// The thinking the runs' reports allow, and so what the tokens gate holds them to. A report from before trials asked for
// none. Runs that asked for none are held to zero thinking, and a trial that asked for a level is not.
export const thinkingPass = (levels: ReadonlyArray<Reasoning | undefined>) => {
  const asked = [...new Set(levels.map((level) => level ?? "none"))].filter((level) => level !== "none").sort();
  return asked.length === 0 ? "thinking 0" : `thinking reported, not gated, as the runs asked for ${asked.join(", ")}`;
};

// The prod repos against their own recipe 1 answers. Recipe 1's legacy receipts hold its final answers only, so the
// comparison is of answers that failed for good. A recipe 1 first-try failure count does not exist to compare with.
export const againstRecipeOne = (rows: ReadonlyArray<SampleRow>, prod: ReadonlySet<number>) => {
  const sampled = rows.filter((row) => prod.has(row.id));
  const gate = decodeGate(sampled);
  const recipeOneFailed = sampled.filter((row) => !row.legacy).length;
  return { ...gate, prod: sampled.length, recipeOneFailed, pass: gate.failed.length <= recipeOneFailed };
};

// The sample file's third column names each repo's stratum, such as "prod" for the 100 enriched prod repos.
export const strataOf = (text: string) =>
  new Map(
    text.split("\n").flatMap((line) => {
      const [id, , stratum] = line.trim().split(/\s+/);
      return line.startsWith("#") || id === undefined || stratum === undefined ? [] : [[Number(id), stratum] as const];
    }),
  );
