import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const localPostgres = {
  scheme: "postgres",
  host: "127.0.0.1",
  port: 54317,
  database: "stargrep",
  user: "stargrep",
  password: Redacted.make("stargrep"),
  sslmode: "disable",
} as const;

const extensions = new URL("../sql/extensions.sql", import.meta.url).pathname;

// Neon deletes a preview branch that no deploy has touched for two weeks, in case its destroy job never ran.
// The date is rounded to the day, so a second deploy on the same day plans no change.
const previewExpiry = DateTime.now.pipe(
  Effect.map((now) => DateTime.formatIso(DateTime.add(DateTime.startOf(now, "day"), { days: 14 }))),
);

const StageBranch = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const project = yield* Neon.Project.ref("Project", { stack: "StargrepDatabase", stage: "shared" });
  const expiry = stage === "prod" ? {} : { expiresAt: yield* previewExpiry };
  return yield* Neon.Branch("Branch", { project, importFiles: [extensions], ...expiry }).pipe(
    RemovalPolicy.retain(stage === "prod"),
  );
});

export const Database = Effect.gen(function* () {
  const origin = (yield* Alchemy.ALCHEMY_DEV) ? localPostgres : (yield* StageBranch).origin;
  return yield* Cloudflare.Hyperdrive.Connection("Database", {
    origin,
    dev: localPostgres,
    caching: { disabled: true },
  });
});
