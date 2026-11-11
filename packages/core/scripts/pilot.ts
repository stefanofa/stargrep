import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Summarize from "@stargrep/ai/summarize";
import { withClient } from "@stargrep/db/local-database";
import * as GitHub from "@stargrep/github/github";
import type { RepoFacts } from "@stargrep/github/schemas";
import { labelKey } from "@stargrep/knowledge/label-key";
import { roles } from "@stargrep/knowledge/registry";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as BlobStore from "../src/repos/blob-store.ts";
import * as Gates from "./pilot-gates.ts";
import { parseRefs, RunReportJson, readRefs } from "./prefill-files.ts";
import * as Runtime from "./runtime.ts";

// Pilot 2 (rollout.md, "The pilot"): a stratified, seeded sample of 300 repos, and the gates table over what the
// prefill driver wrote for it. Neither command calls a model.

const seeded = (seed: string, id: number) => {
  // cyrb53: a fixed order from the seed alone, decided before any answer is seen.
  const text = `${seed}:${id}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

const englishWords = new Set(["the", "and", "of", "to", "is", "for", "with", "this", "that", "you", "it", "in"]);
const otherWords = new Set([
  "de",
  "la",
  "que",
  "el",
  "en",
  "los",
  "las",
  "und",
  "der",
  "die",
  "das",
  "ist",
  "le",
  "les",
  "des",
  "est",
  "et",
  "para",
  "com",
  "não",
  "uma",
  "um",
  "è",
  "il",
  "di",
  "per",
  "con",
  "не",
  "и",
  "в",
  "на",
  "что",
]);

// A README is mostly in another language when most of its letters are outside Latin script, or when its common words
// are more often another language's than English's.
export const otherLanguage = (text: string) => {
  const head = text.slice(0, 4_000);
  const letters = head.match(/\p{L}/gu) ?? [];
  const latin = head.match(/\p{Script=Latin}/gu) ?? [];
  if (letters.length > 50 && latin.length / letters.length < 0.6) return true;
  const words = head.toLowerCase().match(/\p{L}+/gu) ?? [];
  const english = words.filter((word) => englishWords.has(word)).length;
  const other = words.filter((word) => otherWords.has(word)).length;
  return other > english && other >= 5;
};

const comparison =
  /\balternative (to|for)\b|\breplacement for\b|\binstead of\b|\bvs\.?\s|\bversus\b|\bdrop-in\b|\bcompatible with\b|\binspired by\b|\bfork of\b/i;
const deprecated = /\b(deprecated|unmaintained|no longer maintained|not maintained|archived)\b/i;
const listOrMonorepo = /\bcurated list\b|\bawesome list\b|\bmonorepo\b/i;

// The rollout's strata for the 200 prefill repos, with their quotas, in the order a repo that fits several is placed.
const strata = [
  ["no-readme", 20],
  ["other-language", 20],
  ["comparison", 40],
  ["deprecated", 20],
  ["list-or-monorepo", 20],
] as const;
type Stratum = (typeof strata)[number][0];

// Whether a repo belongs to each stratum, from its facts and its cleaned README alone.
const belongs: Record<Stratum, (facts: RepoFacts, readme: string | null, text: string) => boolean> = {
  "no-readme": (facts) => facts.readme === null,
  "other-language": (_, readme) => readme !== null && otherLanguage(readme),
  comparison: (_, __, text) => comparison.test(text),
  deprecated: (facts, _, text) => facts.archived || deprecated.test(text),
  "list-or-monorepo": (facts) =>
    /^awesome[-_]/i.test(facts.name) ||
    listOrMonorepo.test(facts.description ?? "") ||
    facts.topics.some((topic) => ["awesome", "awesome-list", "monorepo"].includes(topic)),
};

export const strataOf = (facts: RepoFacts, readme: string | null): ReadonlyArray<Stratum> => {
  const text = `${facts.description ?? ""}\n${readme?.slice(0, 2_000) ?? ""}`;
  return strata.flatMap(([stratum]) => (belongs[stratum](facts, readme, text) ? [stratum] : []));
};

const seed = Flag.String("seed").pipe(Flag.withDescription("Fixes the sample before any answer is seen"));
const out = Flag.String("out").pipe(Flag.withDescription("Where to write the sample, in the prefill list format"));

const sql = <A>(text: string, values: ReadonlyArray<unknown> = []) =>
  Effect.flatMap(Config.Redacted("DATABASE_URL"), (url) =>
    withClient(Redacted.value(url), async (client) => (await client.query(text, [...values])).rows as Array<A>),
  );

const sample = Command.make(
  "sample",
  {
    seed,
    out,
    list: Flag.String("list").pipe(Flag.withDescription("The prefill list the 200 come from")),
    pool: Flag.Int("pool").pipe(
      Flag.withDescription("How many repos of the list, in seeded order, to read from GitHub to fill the strata"),
      Flag.withDefault(1_500),
    ),
  },
  Effect.fn("pilot.sample")(function* (flags) {
    const github = yield* GitHub.GitHub;
    const blobs = yield* BlobStore.BlobStore;
    const fs = yield* FileSystem.FileSystem;
    // 100 enriched prod repos with a legacy receipt, so the current recipe's answers can be compared with recipe 1 summaries.
    const prod = yield* sql<{ id: number; fullName: string }>(
      `select r.id::float8 as id, r.owner || '/' || r.name as "fullName" from repos r
         where r.summary is not null and r.gone_at is null
           and exists (select 1 from receipts c where c.repo_id = r.id and c.source = 'legacy')`,
    );
    const prodPick = prod.toSorted((a, b) => seeded(flags.seed, a.id) - seeded(flags.seed, b.id)).slice(0, 100);
    const taken = new Set(prod.map((row) => row.id));
    const pool = (yield* readRefs(flags.list))
      .filter((ref) => !taken.has(ref.id))
      .toSorted((a, b) => seeded(flags.seed, a.id) - seeded(flags.seed, b.id))
      .slice(0, flags.pool);
    const { facts } = yield* github.resolveRepos(pool);
    const order = new Map(pool.map((ref, index) => [ref.id, index]));
    const classified = yield* Effect.forEach(
      facts.toSorted((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
      (entry) =>
        Effect.gen(function* () {
          const oid = entry.readme?.oid;
          const text =
            oid === undefined
              ? null
              : yield* Effect.flatMap(blobs.get(BlobStore.readmeKey(oid)), (stored) =>
                  Option.isSome(stored)
                    ? Effect.succeed(stored.value)
                    : github
                        .readme({ owner: entry.owner, name: entry.name, oid })
                        .pipe(Effect.tap((read) => blobs.put(BlobStore.readmeKey(oid), read))),
                ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)));
          const cleaned = text === null ? null : Summarize.readmeText(text);
          return { facts: entry, strata: strataOf(entry, cleaned) };
        }),
      { concurrency: 4 },
    );
    const chosen = new Map<number, { readonly fullName: string; readonly stratum: string }>();
    for (const [stratum, quota] of strata) {
      for (const entry of classified.filter((candidate) => candidate.strata.includes(stratum))) {
        if ([...chosen.values()].filter((pick) => pick.stratum === stratum).length >= quota) break;
        if (!chosen.has(entry.facts.id)) {
          chosen.set(entry.facts.id, { fullName: `${entry.facts.owner}/${entry.facts.name}`, stratum });
        }
      }
    }
    // The rest are general picks in seeded order, topicless first until 30% of the 200 have no topics.
    const topicless = () =>
      classified.filter((entry) => chosen.has(entry.facts.id) && entry.facts.topics.length === 0).length;
    for (const preferTopicless of [true, false]) {
      for (const entry of classified) {
        if (chosen.size >= 200) break;
        if (chosen.has(entry.facts.id)) continue;
        if (preferTopicless && (topicless() >= 60 || entry.facts.topics.length > 0)) continue;
        chosen.set(entry.facts.id, { fullName: `${entry.facts.owner}/${entry.facts.name}`, stratum: "general" });
      }
    }
    const counts = new Map<string, number>();
    for (const pick of chosen.values()) counts.set(pick.stratum, (counts.get(pick.stratum) ?? 0) + 1);
    const lines = [
      `# pilot 2 sample, seed ${flags.seed}: ${prodPick.length} prod repos, ${chosen.size} from ${flags.list} (pool ${pool.length}, ${facts.length} resolved)`,
      `# strata: ${[...counts].map(([stratum, count]) => `${stratum} ${count}`).join(", ")}, topicless ${topicless()}`,
      ...prodPick.map((row) => `${row.id} ${row.fullName} prod`),
      ...[...chosen].map(([id, pick]) => `${id} ${pick.fullName} ${pick.stratum}`),
    ];
    yield* fs.writeFileString(flags.out, `${lines.join("\n")}\n`);
    yield* Console.log(lines.slice(0, 2).join("\n"));
    if (chosen.size < 200) yield* Console.log(`only ${chosen.size} of 200 filled: raise --pool`);
  }, Effect.provide(Runtime.layerPrefill())),
).pipe(Command.withDescription("Pick pilot 2's 300 repos: 100 enriched prod repos and 200 stratified prefill repos"));

const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

// Fits V(n) = K n^β to the distinct minting keys after each repo, in capture order, by least squares on the logs.
export const heaps = (curve: ReadonlyArray<number>) => {
  const points = curve.flatMap((value, index) =>
    index >= 9 && value > 0 ? [[Math.log(index + 1), Math.log(value)]] : [],
  );
  const n = points.length;
  const sx = points.reduce((sum, [x]) => sum + (x ?? 0), 0);
  const sy = points.reduce((sum, [, y]) => sum + (y ?? 0), 0);
  const sxx = points.reduce((sum, [x]) => sum + (x ?? 0) ** 2, 0);
  const sxy = points.reduce((sum, [x, y]) => sum + (x ?? 0) * (y ?? 0), 0);
  const beta = n < 2 ? 1 : (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const logK = n < 2 ? 0 : (sy - beta * sx) / n;
  return { beta, at: (repos: number) => Math.exp(logK) * repos ** beta };
};

const joins = /\s(and|&|\+|or)\s|\/|,/i;
const variantKey = (key: string) => key.replace(/[^\p{L}\p{N}]/gu, "").replace(/(es|s)$/u, "");

const gates = Command.make(
  "gates",
  {
    sampleFile: Flag.String("sample").pipe(Flag.withDescription("The sample file pilot sample wrote")),
    runs: Flag.String("runs").pipe(
      Flag.withDescription(
        "Comma-separated prefill --out reports for the sample's runs, for tokens, repaid items, and capture times. A run killed with SIGKILL writes none, and its gates read the database alone",
      ),
      Flag.withDefault(""),
    ),
    overshoot: Flag.Finite("overshoot").pipe(
      Flag.withDescription("Prod's keyword overshoot correction for the growth projection, as pilot 1 derived it"),
      Flag.withDefault(1),
    ),
    baseInput: Flag.Int("base-input").pipe(Flag.withDescription("Recipe 1's mean input tokens"), Flag.optional),
    baseOutput: Flag.Int("base-output").pipe(Flag.withDescription("Recipe 1's mean output tokens"), Flag.optional),
  },
  Effect.fn("pilot.gates")(function* (flags) {
    const fs = yield* FileSystem.FileSystem;
    const sampleText = yield* fs.readFileString(flags.sampleFile);
    const { refs } = parseRefs(sampleText);
    const ids = refs.map((ref) => ref.id);
    const strata = Gates.strataOf(sampleText);
    const paths = flags.runs
      .split(",")
      .map((path) => path.trim())
      .filter((path) => path !== "");
    const present = yield* Effect.filter(paths, (path) => fs.exists(path));
    const reports = yield* Effect.forEach(present, (path) =>
      Effect.flatMap(fs.readFileString(path), Schema.decodeEffect(RunReportJson)),
    );
    const missingReports = paths.length - present.length;
    const stoppedEarly = reports.filter((report) => !report.finished).length;
    const rows = yield* Gates.decodeSampleRows(yield* sql(Gates.sampleRows, [ids, Gates.recipe]));
    const repeated =
      (yield* Gates.decodeRepeated(yield* sql(Gates.repeatedAsks, [ids, Gates.recipe])))[0]?.repeated ?? 0;
    const decode = Gates.decodeGate(rows);
    const prod = Gates.againstRecipeOne(rows, new Set(ids.filter((id) => strata.get(id) === "prod")));
    const answered = rows.filter((row) => row.claims !== null && row.lanes !== null);
    const sampled = new Set<number>(ids);
    // A resume collects the same batch answers again, so each manifest and repo counts once.
    const usage = [
      ...new Map(
        reports
          .flatMap((report) => report.usage)
          .filter((entry) => sampled.has(entry.repoId))
          .map((entry) => [`${entry.manifest}:${entry.repoId}`, entry] as const),
      ).values(),
    ];
    const mean = (values: ReadonlyArray<number>) =>
      share(
        values.reduce((sum, value) => sum + value, 0),
        values.length,
      );
    const meanInput = mean(usage.flatMap((entry) => (entry.inputTokens === undefined ? [] : [entry.inputTokens])));
    const meanOutput = mean(usage.flatMap((entry) => (entry.outputTokens === undefined ? [] : [entry.outputTokens])));
    const reasoning = usage.reduce((sum, entry) => sum + (entry.reasoningTokens ?? 0), 0);
    const unreportedThinking = usage.filter((entry) => entry.reasoningTokens === undefined).length;
    const thinking =
      usage.length === 0
        ? "unknown, no batch answer reported"
        : unreportedThinking > 0
          ? `unknown for ${unreportedThinking} of ${usage.length} answers, ${reasoning} where reported`
          : `${reasoning}`;

    const minting = answered
      .toSorted((a, b) => (a.capturedAt ?? "").localeCompare(b.capturedAt ?? ""))
      .map((row) => (row.claims ?? []).filter((claim) => roles[claim.role].mints));
    const curve: Array<number> = [];
    const seen = new Set<string>();
    const holders = new Map<string, number>();
    for (const claims of minting) {
      for (const key of new Set(claims.map((claim) => claim.key))) {
        seen.add(key);
        holders.set(key, (holders.get(key) ?? 0) + 1);
      }
      curve.push(seen.size);
    }
    const fit = heaps(curve);
    const listedShare = share([...holders.values()].filter((count) => count >= 2).length, seen.size);
    const listedAt100k = fit.at(100_000) * flags.overshoot * listedShare;
    const variants = new Map<string, number>();
    for (const key of seen) variants.set(variantKey(key), (variants.get(variantKey(key)) ?? 0) + 1);
    const duplicates = [...seen].filter((key) => (variants.get(variantKey(key)) ?? 0) > 1).length;
    const terms = minting.flat();
    const longTerms = terms.filter((claim) => claim.term.split(/\s+/).length > 3 || joins.test(claim.term));
    const selfComparisons = answered.filter((row) =>
      row.altKeys.some((key) => key === labelKey(row.name) || key === labelKey(`${row.owner}/${row.name}`)),
    ).length;
    const withReadme = answered.filter((row) => row.hasReadme);
    const repaid = reports.reduce((sum, report) => sum + report.repaid, 0);
    const captureTimes = reports.flatMap((report) => report.captures);
    const slowest = captureTimes.reduce(
      (worst, capture) => (capture.seconds > worst.seconds ? capture : worst),
      captureTimes[0] ?? { items: 0, seconds: 0 },
    );

    const table: ReadonlyArray<readonly [string, string, string]> = [
      ["Answers", `${answered.length} of ${ids.length} sampled repos have a current receipt`, "-"],
      [
        "Summary model",
        Gates.answerModels(answered)
          .map(([model, count]) => `${model} wrote ${count}`)
          .join(", ") || "no answers",
        "one model",
      ],
      [
        "Whole answers that fail to decode",
        `${decode.retried} of ${decode.asked} asked repos needed a fallback batch (${percent(share(decode.retried, decode.asked))})`,
        "at most 2%",
      ],
      [
        "Answers that never decoded",
        `${decode.failed.length} of ${decode.asked} asked repos failed in their batch and its fallback${decode.failed.length > 0 ? `: ${decode.failed.join(", ")}` : ""}`,
        "reported, and counted in the gate above",
      ],
      [
        "Against recipe 1 on the prod repos",
        `recipe ${Gates.recipe} on the batch path: ${prod.failed.length} never decoded and ${prod.retried} needed a fallback, of ${prod.asked} asked of ${prod.prod}. Recipe 1: ${prod.recipeOneFailed} of ${prod.prod} have no legacy answer. Legacy receipts keep final answers only, so recipe 1 has no first-try count`,
        `no more answers that never decode than recipe 1 (${prod.pass ? "pass" : "fail"})`,
      ],
      [
        "Answers with no facets list",
        `${answered.filter((row) => row.carried || Object.values(row.lanes ?? {}).every((lane) => lane === "missing")).length}`,
        "at most 1%",
      ],
      [
        "Answers with any invalid lane",
        `${answered.filter((row) => Object.values(row.lanes ?? {}).includes("invalid")).length}`,
        "at most 5%",
      ],
      [
        "Coverage",
        `kind ${percent(share(withReadme.filter((row) => row.hasKind).length, withReadme.length))} of repos with a README, about ${percent(share(answered.filter((row) => row.hasAbout).length, answered.length))} of all`,
        "kind 98%, about 97%",
      ],
      ["Self-comparisons after projection", `${selfComparisons}`, "none"],
      [
        "Growth",
        `${Math.round(listedAt100k)} listed at 100k (β ${fit.beta.toFixed(3)}, ${seen.size} minting keys, ${percent(listedShare)} on two or more repos)`,
        "at most 60k",
      ],
      [
        "Duplicates",
        `${duplicates} of ${seen.size} minting keys are a spelling variant of another (${percent(share(duplicates, seen.size))})`,
        "at most 10%",
      ],
      [
        "Terms",
        `${longTerms.length} of ${terms.length} run over three words or join two things (${percent(share(longTerms.length, terms.length))})`,
        "at most 1%",
      ],
      [
        "Tokens",
        `mean input ${Math.round(meanInput)}${Option.match(flags.baseInput, { onNone: () => "", onSome: (base) => ` (+${Math.round(meanInput - base)})` })}, output ${Math.round(meanOutput)}${Option.match(flags.baseOutput, { onNone: () => "", onSome: (base) => ` (+${Math.round(meanOutput - base)})` })}, thinking ${thinking}, over ${usage.length} batch answers`,
        "+880 and +284 within 30%, thinking 0",
      ],
      [
        "Resume",
        `${repaid} repaid items${missingReports > 0 ? `, ${missingReports} runs wrote no report` : ""}${stoppedEarly > 0 ? `, ${stoppedEarly} reports from runs stopped early` : ""}. ${repeated} repos asked twice for one input. Receipts are unique per input, so a second payment shows here, not as a second receipt`,
        "zero and zero",
      ],
      [
        "Writes",
        captureTimes.length === 0
          ? "no batch answers captured"
          : `slowest capture of a batch's answers ${slowest.seconds.toFixed(1)} s for ${slowest.items} answers, over ${captureTimes.length} batches, at the run's chunk concurrency. It leaves out the wait for the batch`,
        "keeps up",
      ],
      [
        "Private cases",
        "deferred: no private capture path exists yet, so the gate moves to the PR that adds it",
        "nothing reaches a public table",
      ],
    ];
    for (const [gate, measured, pass] of table) yield* Console.log(`| ${gate} | ${measured} | ${pass} |`);
  }, Effect.provide(BunServices.layer)),
).pipe(Command.withDescription("Print the pilot 2 gates table for a sample the prefill driver ran"));

Command.make("pilot").pipe(
  Command.withSubcommands([sample, gates]),
  Command.run({ version: "0.0.0" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
