import * as Schema from "effect/Schema";

export const LabelKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)).pipe(
  Schema.brand("LabelKey"),
);
export type LabelKey = typeof LabelKey.Type;

const separators = /[-_/\s]+/g;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const symbolOrSpace = /^[\p{P}\p{S}\s]/u;
const emoji = /^\p{RGI_Emoji}$/v;
const letterOrDigit = /[\p{L}\p{N}]/u;
const maxLength = 80;

// Whole clusters, so a variation selector, a ZWJ sequence, or a keycap leaves nothing behind.
const isEdge = (cluster: string) => symbolOrSpace.test(cluster) || emoji.test(cluster);

// The mention identity of a term: NFKC, lowercase, runs of "-", "_", "/", and whitespace as one space, and punctuation,
// symbol, and emoji clusters trimmed at the edges, except a leading "." and a trailing "+" or "#", so C++, C#, .NET,
// and Node.js keep their identity. No plural folding and no "js" stripping, since those are alias decisions a curator
// can see and undo. Null for a term with no letter or digit, and for a key over 80 characters, which NFKC can produce
// from a shorter term.
export const labelKey = (term: string): LabelKey | null => {
  const text = term.normalize("NFKC").toLowerCase().replace(separators, " ");
  const clusters = Array.from(graphemes.segment(text), ({ segment }) => segment);
  let start = 0;
  let end = clusters.length;
  while (start < end && clusters[start] !== "." && isEdge(clusters[start] ?? "")) start++;
  while (end > start && clusters[end - 1] !== "+" && clusters[end - 1] !== "#" && isEdge(clusters[end - 1] ?? ""))
    end--;
  const key = clusters.slice(start, end).join("");
  return letterOrDigit.test(key) && key.length <= maxLength ? LabelKey.make(key) : null;
};
