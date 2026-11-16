import type { GitHubError } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import { Login, RepoId, RepoName } from "@stargrep/github/schemas";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

// Stargrep's own repo, by ID too, so a rename or a squatter on the old name never answers for it.
const stargrep = { id: RepoId.make(1444651825), owner: Login.make("stefanofa"), name: RepoName.make("stargrep") };

const unavailable = (error: GitHubError) =>
  error._tag === "TokenBudgetExhausted" || error._tag === "RateLimited"
    ? Effect.succeed(null)
    : Effect.logWarning("Stargrep star count failed", { failure: error._tag }).pipe(Effect.as(null));

// The star count the web Worker's header shows, read with the server's token through GitHubGate. It takes no input, so
// the web Worker can read this one repo and nothing else. It never fails, so a spent budget or a GitHub failure answers
// null, which the header renders as no count.
export const stargrepStars = <R>(github: Layer.Layer<GitHub.GitHub, never, R>) =>
  Effect.fn("Worker.stargrepStars")(function* () {
    return yield* GitHub.GitHub.use((client) => client.resolveRepos([stargrep])).pipe(
      Effect.map(({ facts }) => facts[0]?.stars ?? null),
      Effect.catch(unavailable),
      Effect.provide(github),
    );
  });
