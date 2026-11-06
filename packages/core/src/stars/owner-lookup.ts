import type { Owner } from "@stargrep/github/owner";
import type { Login } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class OwnerLookupFailed extends Schema.TaggedError<OwnerLookupFailed, { readonly brand: unique symbol }>()(
  "OwnerLookupFailed",
  {
    reason: Schema.Literals(["budget", "github", "transport", "timeout", "reply-invalid"]),
  },
) {
  override get message(): string {
    return `Looking up a GitHub login failed at ${this.reason}`;
  }
}

export class OwnerLookup extends Context.Service<
  OwnerLookup,
  {
    // None when GitHub has no user or org with the login.
    readonly lookup: (login: Login) => Effect.Effect<Option.Option<Owner>, OwnerLookupFailed>;
  }
>()("@stargrep/core/stars/owner-lookup/OwnerLookup") {}

// Answers from `owners`, keyed by lowercase login, and records each lookup so tests count what reached GitHub.
export const layerMemory = () => {
  const owners = new Map<string, Owner>();
  const lookups: Array<Login> = [];
  const layer = Layer.succeed(
    OwnerLookup,
    OwnerLookup.of({
      lookup: Effect.fn("OwnerLookup.lookup")(function* (login: Login) {
        yield* Effect.sync(() => lookups.push(login));
        return Option.fromUndefinedOr(owners.get(login.toLowerCase()));
      }),
    }),
  );
  return { owners, lookups, layer };
};
