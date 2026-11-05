import { FetchIcon, IconQueue } from "@stargrep/core/icons";
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

export const pipeline = Settle.pipeline({
  schema: IconQueue.IconMessage,
  run: Effect.fn("FetchIconConsumer.run")(function* (messages) {
    const icons = yield* FetchIcon.FetchIcon;
    return yield* Effect.forEach(
      messages,
      (message) => handle(icons, message).pipe(Effect.as(Settle.Settlement.Done()), Effect.result),
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
});
