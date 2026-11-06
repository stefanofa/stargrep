import type { GitHubError } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import { OwnerReply } from "@stargrep/github/owner";
import { Login } from "@stargrep/github/schemas";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeLogin = Schema.decodeUnknownEffect(Login);
const encodeReply = Schema.encodeEffect(OwnerReply);

const missing: OwnerReply = { _tag: "Missing" };

const unavailable = (error: GitHubError) =>
  error._tag === "TokenBudgetExhausted" || error._tag === "RateLimited"
    ? Effect.succeed<OwnerReply>({ _tag: "Unavailable", reason: "budget" })
    : Effect.logWarning("Owner lookup failed", { failure: error._tag }).pipe(
        Effect.as<OwnerReply>({ _tag: "Unavailable", reason: "github" }),
      );

// The web Worker's only way to GitHub, as an RPC method the internet cannot reach. The token stays in GitHubGate.
// It never fails, so the caller decodes a reply instead of an RPC error envelope.
export const lookupOwner = <R>(github: Layer.Layer<GitHub.GitHub, never, R>) =>
  Effect.fn("Worker.lookupOwner")(function* (login: unknown) {
    const reply = yield* decodeLogin(login).pipe(
      Effect.flatMap((valid) =>
        GitHub.GitHub.use((client) => client.owner(valid)).pipe(
          Effect.map(
            Option.match({ onNone: () => missing, onSome: (owner): OwnerReply => ({ _tag: "Found", owner }) }),
          ),
          Effect.catch(unavailable),
          Effect.provide(github),
        ),
      ),
      Effect.catchTags({ SchemaError: () => Effect.succeed(missing) }),
    );
    return yield* Effect.orDie(encodeReply(reply));
  });
