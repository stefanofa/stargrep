import { OwnerLookup } from "@stargrep/core/stars";
import { OwnerReply } from "@stargrep/github/owner";
import type { Login } from "@stargrep/github/schemas";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const lookupTimeout = "5 seconds";

const decodeReply = Schema.decodeUnknownEffect(OwnerReply);

export interface OwnerWorker {
  readonly lookupOwner: (login: string) => Promise<unknown>;
}

const failed = (reason: OwnerLookup.OwnerLookupFailed["reason"]) => new OwnerLookup.OwnerLookupFailed({ reason });

// The main Worker answers a plain reply. Anything else, such as Alchemy's RPC error envelope, fails as an invalid reply.
export const layerOwnerLookup = (worker: OwnerWorker) =>
  Layer.succeed(
    OwnerLookup.OwnerLookup,
    OwnerLookup.OwnerLookup.of({
      lookup: Effect.fn("OwnerLookup.lookup")(function* (login: Login) {
        const raw = yield* Effect.tryPromise({
          try: () => worker.lookupOwner(login),
          catch: () => failed("transport"),
        }).pipe(Effect.timeoutOrElse({ duration: lookupTimeout, orElse: () => Effect.fail(failed("timeout")) }));
        const reply = yield* decodeReply(raw).pipe(Effect.mapError(() => failed("reply-invalid")));
        switch (reply._tag) {
          case "Found":
            return Option.some(reply.owner);
          case "Missing":
            return Option.none();
          case "Unavailable":
            return yield* failed(reply.reason);
        }
      }),
    }),
  );
