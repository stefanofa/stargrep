import { summaryRecipe } from "@stargrep/ai/models";
import type { ObjectId, RepoId } from "@stargrep/github/schemas";
import { decodeFacets } from "@stargrep/knowledge/claims";
import { ReceiptId } from "@stargrep/knowledge/ids";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Db from "../src/db.ts";

export interface Summary {
  readonly id: RepoId;
  readonly readmeOid: ObjectId | null;
  readonly summary: string;
  readonly keywords: ReadonlyArray<string>;
  readonly kind?: string;
  // The facts the summary model stated, as it writes them. The kind, when given, is the first.
  readonly facts?: ReadonlyArray<{ readonly role: string; readonly term: string }>;
}

const noPrompt = { fullName: "", description: "", topics: [], readme: "" };

const factsOf = (repo: Db.Repo): Db.RepoFacts => ({
  id: repo.id,
  owner: repo.owner,
  name: repo.name,
  description: repo.description,
  topics: repo.topics,
  language: repo.language,
  license: repo.license,
  homepage: repo.homepage,
  createdAt: repo.createdAt,
  pushedAt: repo.pushedAt,
  archived: repo.archived,
  readmeOid: repo.readmeOid,
  ownerType: repo.ownerType,
  ownerAvatarUrl: repo.ownerAvatarUrl,
});

// A summary saved the way enrichment saves one: commit A captures a model answer to the repo's facts as they stand,
// with the kind as its only claim. Returns whether the repo now shows it. A second answer to the same facts converges
// on the first receipt, as a retried answer does, so a test that wants another summary changes the facts first.
export const summarize = Effect.fn("summarize")(function* (summary: Summary) {
  const db = yield* Db.Db;
  const { inputHash } = yield* db.repos.saveFacts(factsOf(yield* db.repos.require(summary.id)));
  const receiptId = ReceiptId.make(
    yield* SecureRandom.SecureRandom.use((random) => random.uuidV4()).pipe(Effect.provide(SecureRandom.layerWebCrypto)),
  );
  const facets = decodeFacets(
    [...(summary.kind === undefined ? [] : [{ role: "is", term: summary.kind }]), ...(summary.facts ?? [])],
    noPrompt,
  );
  const [captured] = yield* db.knowledge.capture([
    {
      receiptId,
      repoId: summary.id,
      source: "model",
      inputHash,
      readmeOid: summary.readmeOid,
      recipe: summaryRecipe,
      model: "test/summary",
      batchId: null,
      summary: summary.summary,
      keywords: summary.keywords,
      claims: facets.claims,
      lanes: facets.lanes,
      dropped: facets.dropped,
      rawKey: null,
      lease: null,
    },
  ]);
  return captured?.saved === true;
});
