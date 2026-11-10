import * as Effect from "effect/Effect";
import * as Counts from "./counts.ts";
import * as Curation from "./curation.ts";
import * as Projection from "./projection.ts";
import * as Receipts from "./receipts.ts";

export type { Decided, Decision, DecisionRow, Reach, SubjectInfo, Variant } from "./curation.ts";
export type { Label, LockedRepo, MintClaim, Minted, Projected, Projection, StoredAtom } from "./projection.ts";
export type { Answer, Captured, ReceiptSource } from "./receipts.ts";

// The only writer of the knowledge tables. Capture saves answers, mint and decide change the vocabulary, and project
// writes the atoms, each under the lock protocol in lock.ts.
export interface Queries extends Receipts.Queries, Projection.Queries, Curation.Queries, Counts.Queries {}

export const make = Effect.gen(function* () {
  return {
    ...(yield* Receipts.make),
    ...(yield* Projection.make),
    ...(yield* Curation.make),
    ...(yield* Counts.make),
  } satisfies Queries;
});
