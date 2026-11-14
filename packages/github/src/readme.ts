import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { blobOid } from "./blob-oid.ts";
import { type GraphQLError, type Login, ObjectId, type RepoFile, type RepoName, type RepoNodeId } from "./schemas.ts";

export const TreeEntry = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  oid: ObjectId,
});
export type TreeEntry = typeof TreeEntry.Type;

const readmeName = /^readme(\.[^.]+)?$/i;
const extensionRank = [".md", ".markdown", ".mdx", ".rst", ".adoc", ".asciidoc", ".org", ".txt", ""];

const rank = (name: string) => {
  const extension = (name.match(readmeName)?.[1] ?? "").toLowerCase();
  const index = extensionRank.indexOf(extension);
  return index === -1 ? extensionRank.length : index;
};

export const pickReadme = (entries: ReadonlyArray<TreeEntry>): RepoFile | null => {
  const candidates = entries
    .filter((entry) => entry.type === "blob" && readmeName.test(entry.name))
    .toSorted((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  const best = candidates[0];
  return best === undefined ? null : { name: best.name, oid: best.oid };
};

export const request = (input: { readonly owner: Login; readonly name: RepoName; readonly oid: ObjectId }) =>
  HttpClientRequest.get(
    `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/git/blobs/${input.oid}`,
  ).pipe(HttpClientRequest.accept("application/vnd.github.raw+json"));

// The README pickReadme chose, in the repo that holds it. A node ID survives a rename, where an owner and name do not.
export interface ReadmeRef {
  readonly nodeId: RepoNodeId;
  readonly oid: ObjectId;
}

// A batch costs one GraphQL point whatever its size. 22 READMEs, 1.2 MB in all, measured 1.5 s.
export const batchSize = 25;

const alias = (index: number) => `b${index}`;

export const batchQuery = (count: number) => {
  const variables = Array.from({ length: count }, (_, index) => `$r${index}: ID!, $o${index}: GitObjectID!`);
  const lookups = Array.from(
    { length: count },
    (_, index) =>
      `  ${alias(index)}: node(id: $r${index}) { ... on Repository { object(oid: $o${index}) { ... on Blob { text } } } }`,
  );
  return `query Readmes(${variables.join(", ")}) {\n${lookups.join("\n")}\n}`;
};

export const batchVariables = (refs: ReadonlyArray<ReadmeRef>) =>
  Object.fromEntries(
    refs.flatMap((ref, index) => [
      [`r${index}`, ref.nodeId],
      [`o${index}`, ref.oid],
    ]),
  );

export const BatchData = Schema.Record(
  Schema.String,
  Schema.NullOr(
    Schema.Struct({
      object: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ text: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
      ),
    }),
  ),
);

// A repo GitHub no longer has or forbids the token fails only its own alias.
export const isAliasError = (error: GraphQLError) => {
  const [field] = error.path ?? [];
  return (
    typeof field === "string" && /^b\d+$/.test(field) && (error.type === "NOT_FOUND" || error.type === "FORBIDDEN")
  );
};

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

// Keeps a text only when its bytes hash to the object ID asked for, which a truncated or re-encoded text never does.
// Those bytes are then decoded the way fetch decodes a REST body, which drops a leading byte order mark, so a README
// read either way is the same string.
export const verify = Effect.fnUntraced(function* (refs: ReadonlyArray<ReadmeRef>, data: typeof BatchData.Type) {
  const texts = new Map<ObjectId, string>();
  for (const [index, ref] of refs.entries()) {
    const text = data[alias(index)]?.object?.text;
    if (typeof text !== "string") continue;
    const bytes = utf8.encode(text);
    if ((yield* blobOid(bytes)) === ref.oid) texts.set(ref.oid, decoder.decode(bytes));
  }
  return texts;
});
