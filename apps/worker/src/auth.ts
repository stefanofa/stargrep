import { githubSignIn, names, optionalSecret, required } from "@stargrep/auth/config";
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

// The main Worker reads a signed-in user's token for the work they started. A stage that signs in through prod's proxy
// has no client secret, so its tokens cannot refresh there.
export const tokenBindings = Effect.fn("tokenBindings")(function* (stage: string) {
  const signIn = yield* githubSignIn;
  if (Option.isNone(signIn)) return {};
  return {
    [names.clientId]: signIn.value.clientId,
    ...(signIn.value._tag === "direct" ? { [names.clientSecret]: signIn.value.clientSecret } : {}),
    [names.secret]: yield* betterAuthSecret(stage),
  };
});
