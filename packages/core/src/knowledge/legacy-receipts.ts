import * as Db from "@stargrep/db";
import { legacyFacets } from "@stargrep/knowledge/claims";
import { inputHash } from "@stargrep/knowledge/input-hash";
import * as Arr from "effect/Array";
import type * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";

// Repos one page locks and writes.
const pageSize = 128;

const sameContent = (current: Db.LegacyContent, repo: Db.LegacyRepo) =>
  current.recipe === repo.summaryRecipe &&
  current.summary === repo.summary &&
  current.keywords.length === repo.keywords.length &&
  current.keywords.every((keyword, index) => keyword === repo.keywords[index]);

// The legacy receipt a repo's summary columns make, or none when its legacy receipt already holds them. The summary
// model wrote the kind with the summary and keywords, so the kind never changes alone. The input hash names the README
// the summary was made from and the repo's facts now, the closest record of its prompt there is.
const answerFor = (repo: Db.LegacyRepo): Effect.Effect<ReadonlyArray<Db.LegacyAnswer>, never, Digest.Digest> => {
  if (repo.current !== null && sameContent(repo.current, repo)) return Effect.succeed([]);
  const facets = legacyFacets(repo);
  return inputHash({
    readmeOid: repo.summaryReadmeOid,
    fullName: `${repo.owner}/${repo.name}`,
    description: repo.description,
    topics: repo.topics,
    language: repo.language,
  }).pipe(
    Effect.map((hash) => [
      {
        repoId: repo.id,
        inputHash: hash,
        recipe: repo.summaryRecipe,
        summary: repo.summary,
        keywords: repo.keywords,
        claims: facets.claims,
        lanes: facets.lanes,
        dropped: facets.dropped,
      },
    ]),
  );
};

// Gives every live repo summarized before receipts a legacy receipt from its summary, keywords, and kind, with no model
// call, and points the repo at it, which marks it stale for the projection sweep. It walks repos in ID order, one
// transaction per page, so a run that dies loses only its open page. A repo whose legacy receipt already holds its
// columns is skipped, so a rerun writes nothing, and one summarized again since gets a new receipt. A repo with a model
// receipt is never touched.
export const keepLegacySummaries = Effect.fn("LegacyReceipts.keepLegacySummaries")(function* (
  options: { readonly pageSize: number } = { pageSize },
) {
  const db = yield* Db.Db;
  const totals = { pages: 0, read: 0, inserted: 0, pointed: 0 };
  let after = 0;
  for (;;) {
    const page = yield* db.knowledge.keepLegacy({ after, limit: options.pageSize }, (repos) =>
      Effect.map(Effect.forEach(repos, answerFor), Arr.flatten),
    );
    totals.pages++;
    totals.read += page.read;
    totals.inserted += page.inserted;
    totals.pointed += page.pointed;
    yield* Effect.logInfo("Legacy receipts page kept", { after, ...page });
    if (page.last === null) return totals;
    after = page.last;
  }
});
