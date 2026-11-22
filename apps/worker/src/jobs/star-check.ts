import { StarCheck, type SyncQueue } from "@stargrep/core/stars";
import type * as Db from "@stargrep/db";
import type * as GitHub from "@stargrep/github/github";
import type { BudgetShare } from "@stargrep/github/schemas";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

// A check still running at the next fire would probe the same accounts twice.
const timeout = Duration.minutes(5);

export const run = <E, R>(
  runtime: Layer.Layer<Db.Db | GitHub.GitHub | SyncQueue.SyncQueue, E, R>,
  share: BudgetShare,
) =>
  StarCheck.run(share).pipe(
    Effect.timeout(timeout),
    Effect.provide(runtime),
    Effect.asVoid,
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logError("Star check failed", { cause }),
    ),
  );
