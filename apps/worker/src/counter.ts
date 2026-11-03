import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

export default class Counter extends Cloudflare.DurableObject<Counter>()(
  "Counter",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.succeed({
      increment: Effect.fn("Counter.increment")(function* () {
        const next = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
        yield* state.storage.put("count", next);
        return next;
      }),
    });
  }),
) {}
