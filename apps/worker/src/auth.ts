import { names, optionalSecret, required, tokenClientBindings } from "@stargrep/auth/config";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const BetterAuthSecret = Alchemy.makeRandom("BetterAuthSecret");

// Both Workers decrypt the tokens Better Auth stores, so they bind the same secret. Prod reads it from its environment,
// and a preview stage makes a random one unless its environment sets one.
export const betterAuthSecret = Effect.fn("betterAuthSecret")(function* (stage: string) {
  if (stage === "prod") return yield* required(names.secret);
  const secret = yield* optionalSecret(names.secret);
  return Option.isSome(secret) ? secret.value : yield* BetterAuthSecret;
});

// The main Worker reads a signed-in user's token for the work they started.
export const tokenBindings = Effect.fn("tokenBindings")(function* (stage: string) {
  const client = yield* tokenClientBindings;
  if (!(names.clientId in client)) return {};
  return { ...client, [names.secret]: yield* betterAuthSecret(stage) };
});
