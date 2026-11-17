import { Login, RepoId } from "@stargrep/github/schemas";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as EnrichQueue from "../src/repos/enrich-queue.ts";

// GitHub logins hold letters, digits, hyphens, and, for managed users, underscores, so a column of anything else, such as
// repo names, is refused.
const decodeLogin = Schema.decodeUnknownOption(Login.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))));
const decodeRepoId = Schema.decodeUnknownOption(RepoId);

// The login list: one login per line, in the order to import them. A line's first tab-separated column is the login,
// so a ranked table with the login first works as it is. Blank lines and lines starting with # are ignored.
export const parseLogins = (text: string) => {
  const logins: Array<Login> = [];
  const invalid: Array<number> = [];
  text.split("\n").forEach((line, index) => {
    const login = (line.split("\t")[0] ?? "").trim();
    if (login === "" || login.startsWith("#")) return;
    const decoded = decodeLogin(login);
    if (Option.isSome(decoded)) logins.push(decoded.value);
    else invalid.push(index + 1);
  });
  return { logins, invalid };
};

// The pending file holds one repo ID per line, the repos the import would have sent to enrichment. A repo several
// accounts starred appears once per account, and a line a crash cut short is skipped.
export const parsePending = (text: string) => [
  ...new Set(
    text.split("\n").flatMap((line) => {
      const id = decodeRepoId(Number(line.trim()));
      return line.trim() !== "" && Option.isSome(id) ? [id.value] : [];
    }),
  ),
];

export const statePaths = (state: string) =>
  Effect.map(Path.Path, (path) => ({
    pending: path.join(state, "pending.txt"),
    failures: path.join(state, "failures.jsonl"),
  }));

// Enrichment for an import on a developer's machine: each repo the sync would send to the queue is appended to the
// pending file instead, so the Worker's queue and its token see none of the import.
export const layerPendingFile = (file: string) =>
  Layer.effect(
    EnrichQueue.EnrichQueue,
    Effect.map(FileSystem.FileSystem, (fs) =>
      EnrichQueue.EnrichQueue.of({
        send: Effect.fn("EnrichQueue.send")(function* (messages: ReadonlyArray<EnrichQueue.EnrichRepo>) {
          yield* fs
            .writeFileString(file, messages.map((message) => `${message.repoId}\n`).join(""), { flag: "a" })
            .pipe(Effect.mapError((cause) => new EnrichQueue.EnrichQueueFailed({ messages: messages.length, cause })));
        }),
      }),
    ),
  );

export const FailureJson = Schema.fromJsonString(
  Schema.Struct({ login: Schema.String, attempt: Schema.Int, reason: Schema.String, at: Schema.String }),
);

const Account = Schema.Struct({
  login: Schema.String,
  outcome: Schema.Literals(["Imported", "AlreadySynced", "TooManyStars", "Missing", "Failed"]),
  stars: Schema.optionalKey(Schema.Int),
  pages: Schema.optionalKey(Schema.Int),
  rows: Schema.optionalKey(Schema.Int),
  newRepos: Schema.optionalKey(Schema.Int),
  millis: Schema.optionalKey(Schema.Int),
  attempt: Schema.Int,
  reason: Schema.optionalKey(Schema.String),
});
export type Account = typeof Account.Type;

export const ReportJson = Schema.fromJsonString(
  Schema.Struct({
    elapsedMillis: Schema.Int,
    // Whether the run ended on its own, or was stopped and wrote what it had done so far.
    finished: Schema.Boolean,
    pages: Schema.Int,
    pagesPerHour: Schema.Int,
    // Logins that still failed after every retry.
    failed: Schema.Array(Schema.String),
    // One entry per attempt, in the order the run made them.
    accounts: Schema.Array(Account),
  }),
);
