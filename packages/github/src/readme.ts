import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { type Login, ObjectId, type Readme, type RepoName } from "./schemas.ts";

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

export const pickReadme = (entries: ReadonlyArray<TreeEntry>): Readme | null => {
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
