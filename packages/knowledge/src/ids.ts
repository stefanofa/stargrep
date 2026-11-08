import * as Schema from "effect/Schema";

// A subject's permanent ID. Never reused: a merged ID keeps resolving to its survivor, and a split ID keeps its broad
// meaning.
export const SubjectId = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
).pipe(Schema.brand("SubjectId"));
export type SubjectId = typeof SubjectId.Type;

// A position in a namespace's curation log. 0 is the empty log, and each decision takes the next revision under the
// namespace's exclusive lock, so revisions are dense and commit in order.
export const Revision = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
).pipe(Schema.brand("KnowledgeRevision"));
export type Revision = typeof Revision.Type;

export const ReceiptId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("ReceiptId"));
export type ReceiptId = typeof ReceiptId.Type;

export const BatchId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("BatchId"));
export type BatchId = typeof BatchId.Type;

// SHA-256, in lowercase hex, of the prompt inputs an answer was made from.
export const InputHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(Schema.brand("InputHash"));
export type InputHash = typeof InputHash.Type;

export const SelectionId = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
).pipe(Schema.brand("SelectionId"));
export type SelectionId = typeof SelectionId.Type;
