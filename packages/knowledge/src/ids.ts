import * as Schema from "effect/Schema";

// A subject's permanent ID. Never reused: a merged ID keeps resolving to its survivor, and a split ID keeps its broad
// meaning.
export const SubjectId = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
).pipe(Schema.brand("SubjectId"));
export type SubjectId = typeof SubjectId.Type;
