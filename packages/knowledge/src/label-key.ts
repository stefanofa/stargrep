import * as Schema from "effect/Schema";

export const LabelKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)).pipe(
  Schema.brand("LabelKey"),
);
export type LabelKey = typeof LabelKey.Type;

const separators = /[-_/\s]+/g;
const leadingEdge = /^(?:(?!\.)[\p{P}\p{S}]|\s)+/u;
const trailingEdge = /(?:(?![+#])[\p{P}\p{S}]|\s)+$/u;
const letterOrDigit = /[\p{L}\p{N}]/u;
const maxLength = 80;

// The mention identity of a term: NFKC, lowercase, runs of "-", "_", "/", and whitespace as one space, and edge
// punctuation and symbols trimmed, except a leading "." and a trailing "+" or "#", so C++, C#, .NET, and Node.js keep
// their identity. No plural folding and no "js" stripping, since those are alias decisions a curator can see and undo.
// Null for a term with no letter or digit, and for a key over 80 characters, which NFKC can produce from a shorter
// term.
export const labelKey = (term: string): LabelKey | null => {
  const key = term
    .normalize("NFKC")
    .toLowerCase()
    .replace(separators, " ")
    .replace(leadingEdge, "")
    .replace(trailingEdge, "");
  return letterOrDigit.test(key) && key.length <= maxLength ? LabelKey.make(key) : null;
};
