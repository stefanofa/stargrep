import { FetchIcon, IconQueue } from "@stargrep/core/icons";
import * as Db from "@stargrep/db";
import * as Effect from "effect/Effect";
import * as Settle from "./settle.ts";

const concurrency = 2;

const handle = (
  icons: FetchIcon.FetchIcon["Service"],
  message: IconQueue.IconMessage,
): Effect.Effect<unknown, Settle.Failure> => {
  switch (message._tag) {
    case "IconRequest":
      return icons.fetchIcon(message);
    case "BackfillIcons":
      return icons.backfill(message.after);
  }
};

// An icon request that used up its retries would fail the same way tomorrow, so it counts as checked and keeps the icon
// the repo has. Otherwise the daily backfill sends it again, and it waits for the periodic refresh instead.
const recordCheck = Effect.fn("FetchIconConsumer.recordCheck")(function* (message: IconQueue.IconMessage) {
  if (message._tag !== "IconRequest") return;
  const db = yield* Db.Db;
  yield* db.repos.markIconChecked(message.repoId);
});

export const pipeline = Settle.pipeline({
  schema: IconQueue.IconMessage,
  run: Effect.fn("FetchIconConsumer.run")(function* (deliveries) {
    const icons = yield* FetchIcon.FetchIcon;
    return yield* Effect.forEach(
      deliveries,
      ({ body }) => handle(icons, body).pipe(Effect.as(Settle.Settlement.Done()), Effect.result),
      { concurrency },
    );
  }),
  describe: (message) => {
    switch (message._tag) {
      case "IconRequest":
        return { repoId: message.repoId };
      case "BackfillIcons":
        return { backfillAfter: message.after };
    }
  },
  onDeadLetter: recordCheck,
});
