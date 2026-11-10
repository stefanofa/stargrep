import * as Schema from "effect/Schema";
import { evidenceText } from "./evidence-text.ts";
import { LabelKey, labelKey } from "./label-key.ts";
import { RoleId } from "./registry.ts";

// The roles the summary model writes, one lane each: those with a prompt line, which a test checks. GitHub facts and
// curation write the others.
export const ModelRole = Schema.Literals([
  "is",
  "status",
  "written_in",
  "runs_on",
  "for",
  "built_with",
  "about",
  "trait",
  "alternative_to",
  "replaced_by",
]);
export type ModelRole = typeof ModelRole.Type;
export const modelRoles = ModelRole.literals;

const isModelRole = (role: string): role is ModelRole => (modelRoles as ReadonlyArray<string>).includes(role);

// The decoder reads at most this many items of the list. The prompt asks for 12.
export const maxItems = 32;
export const maxTermLength = 80;
export const maxQuoteLength = 240;

// One decoded claim. The ordinal is its position in the model's list. found is set where the exact prompt text is in
// hand: quote when the quote occurs in it, term when only the term does, so projection never needs the text again.
export const Claim = Schema.Struct({
  ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: maxItems - 1 })),
  role: RoleId,
  term: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxTermLength)),
  key: LabelKey,
  quote: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxQuoteLength))),
  found: Schema.Literals(["quote", "term", "neither"]),
});
export type Claim = typeof Claim.Type;

// complete: the list decoded and every item in this role decoded. invalid: an item in this role, or an item whose role
// could not be read, failed. missing: the answer had no list.
export const LaneState = Schema.Literals(["complete", "invalid", "missing"]);
export type LaneState = typeof LaneState.Type;

export const Lanes = Schema.Record(ModelRole, LaneState);
export type Lanes = typeof Lanes.Type;

// An item the decoder could not read, as a bounded code and never model text. over-limit marks the first item past
// maxItems, once, however many follow it.
export const DroppedItem = Schema.Struct({
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  issue: Schema.Literals(["not-an-object", "unknown-role", "empty-term", "too-long", "over-limit"]),
});
export type DroppedItem = typeof DroppedItem.Type;

// The exact text the prompt carried. Evidence is matched against it, never against what the database holds later.
export interface PromptInput {
  readonly fullName: string;
  readonly description: string;
  readonly topics: ReadonlyArray<string>;
  readonly readme: string;
}

export const DecodedFacets = Schema.Struct({
  claims: Schema.Array(Claim),
  lanes: Lanes,
  dropped: Schema.Array(DroppedItem),
});
export type DecodedFacets = typeof DecodedFacets.Type;

const allLanes = (state: LaneState): Record<ModelRole, LaneState> =>
  Object.fromEntries(modelRoles.map((role) => [role, state])) as Record<ModelRole, LaneState>;

const letterOrDigit = /[\p{L}\p{N}]/u;

// Model text can hold lone surrogates and U+0000, which Postgres refuses in jsonb and text. Surrogates become U+FFFD and
// U+0000 goes.
export const storable = (text: string): string => text.toWellFormed().replaceAll("\u0000", "");
// A quote is also cut on a code point boundary.
const clip = (text: string) => {
  let clipped = "";
  for (const point of text) {
    if (clipped.length + point.length > maxQuoteLength) break;
    clipped += point;
  }
  return clipped;
};

type Read =
  | { readonly _tag: "Claim"; readonly claim: Claim }
  | { readonly _tag: "Dropped"; readonly item: DroppedItem; readonly role: ModelRole | null };

const readItem = (item: unknown, ordinal: number, occurs: (text: string) => boolean): Read => {
  const dropped = (issue: DroppedItem["issue"], role: ModelRole | null = null): Read => ({
    _tag: "Dropped",
    item: { ordinal, issue },
    role,
  });
  if (typeof item !== "object" || item === null || Array.isArray(item)) return dropped("not-an-object");
  const fields = item as Record<string, unknown>;
  const role = typeof fields.role === "string" ? fields.role.trim() : "";
  if (!isModelRole(role)) return dropped("unknown-role");
  const term = typeof fields.term === "string" ? storable(fields.term).trim() : "";
  if (term.length > maxTermLength) return dropped("too-long", role);
  const key = labelKey(term);
  if (key === null) return dropped(letterOrDigit.test(term.normalize("NFKC")) ? "too-long" : "empty-term", role);
  const quoted = typeof fields.quote === "string" ? clip(storable(fields.quote).trim()) : "";
  const quote = quoted.length > 0 ? quoted : null;
  const found = quote !== null && occurs(quote) ? "quote" : occurs(term) ? "term" : "neither";
  return { _tag: "Claim", claim: { ordinal, role, term, key, quote, found } };
};

// The facets list of a model answer, read item by item against the exact prompt input. It never fails: a list that is
// absent or not an array makes every lane missing, and a bad item is dropped with an issue code and turns only its own
// lane invalid, or every lane when its role cannot be read.
export const decodeFacets = (raw: unknown, input: PromptInput): DecodedFacets => {
  if (!Array.isArray(raw)) return { claims: [], lanes: allLanes("missing"), dropped: [] };
  const fields = [input.fullName, input.description, input.topics.join(", "), input.readme]
    .map(evidenceText)
    .filter((field) => field.length > 0);
  // Markup alone has empty evidence text, which occurs in every input, so it never counts as found.
  const occurs = (text: string) => {
    const needle = evidenceText(text);
    return needle.length > 0 && fields.some((field) => field.includes(needle));
  };
  const lanes = allLanes("complete");
  const claims: Array<Claim> = [];
  const dropped: Array<DroppedItem> = [];
  for (const [ordinal, item] of raw.slice(0, maxItems).entries()) {
    const read = readItem(item, ordinal, occurs);
    if (read._tag === "Claim") {
      claims.push(read.claim);
      continue;
    }
    dropped.push(read.item);
    if (read.role !== null) lanes[read.role] = "invalid";
    else for (const role of modelRoles) lanes[role] = "invalid";
  }
  if (raw.length > maxItems) dropped.push({ ordinal: maxItems, issue: "over-limit" });
  return { claims, lanes, dropped };
};
