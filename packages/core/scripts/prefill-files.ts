import { Login, RepoId, RepoName } from "@stargrep/github/schemas";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const ArchiveLine = Schema.Struct({ id: RepoId, owner: Login, name: RepoName });
const decodeLine = Schema.decodeUnknownOption(ArchiveLine);

// The prefill list: one repo per line as "<numeric id> <owner>/<name>", as GH Archive names them. Anything after the
// name, such as a sample's stratum, and lines starting with # are ignored.
export const parseRefs = (text: string) => {
  const refs: Array<typeof ArchiveLine.Type> = [];
  const invalid: Array<number> = [];
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const [id, fullName] = trimmed.split(/\s+/);
    const [owner, name] = (fullName ?? "").split("/");
    const decoded = decodeLine({ id: Number(id), owner, name });
    if (decoded._tag === "Some") refs.push(decoded.value);
    else invalid.push(index + 1);
  });
  return { refs, invalid };
};

export const readRefs = Effect.fn("prefill.readRefs")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const { refs, invalid } = parseRefs(yield* fs.readFileString(path));
  if (invalid.length > 0) {
    return yield* Effect.die(new Error(`${path} has unreadable lines: ${invalid.slice(0, 10).join(", ")}`));
  }
  return refs;
});

const Report = Schema.Struct({
  elapsedMillis: Schema.Int,
  outcomes: Schema.Array(Schema.Tuple([Schema.Int, Schema.String])),
  unresolved: Schema.Array(Schema.Struct({ id: Schema.Int, reason: Schema.String })),
  // Whether the run ended on its own, or was stopped and wrote what it had done so far.
  finished: Schema.Boolean,
  manifests: Schema.Struct({
    resumed: Schema.Int,
    dropped: Schema.Int,
    created: Schema.Int,
    closed: Schema.Int,
    fallbacks: Schema.Int,
    stuck: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        requestObject: Schema.String,
        providerBatchId: Schema.NullOr(Schema.String),
        reason: Schema.Literals(["missing", "unreadable", "changed", "unknown-batch"]),
      }),
    ),
  }),
  retriedRepos: Schema.Array(Schema.Int),
  repaid: Schema.Int,
  captures: Schema.Array(Schema.Struct({ items: Schema.Int, seconds: Schema.Finite })),
  usage: Schema.Array(
    Schema.Struct({
      manifest: Schema.String,
      repoId: Schema.Int,
      inputTokens: Schema.optional(Schema.Int),
      outputTokens: Schema.optional(Schema.Int),
      reasoningTokens: Schema.optional(Schema.Int),
    }),
  ),
  // Tokens of every direct call, such as the CLI's. input counts cached input too, and cacheRead and cacheWrite are the
  // shares of it the provider read from or wrote to its prompt cache. Reports before those shares lack them.
  directTokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cacheRead: Schema.optional(Schema.Finite),
    cacheWrite: Schema.optional(Schema.Finite),
  }),
  statements: Schema.Array(Schema.Tuple([Schema.String, Schema.Int])),
});
export type RunReport = typeof Report.Type;
export const RunReportJson = Schema.fromJsonString(Report);
