import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import { InputHash } from "./ids.ts";

// The GitHub facts a summary prompt is built from, with the README named by its object ID.
export interface PromptFacts {
  readonly readmeOid: string | null;
  readonly fullName: string;
  readonly description: string | null;
  readonly topics: ReadonlyArray<string>;
  readonly language: string | null;
}

// Bump it when the prompt starts reading these facts differently, such as a new README cleaning step, so every
// repo's hash moves and no answer to the old input counts as an answer to the new one.
export const inputVersion = 1;

const utf8 = new TextEncoder();

// SHA-256 of the facts as one JSON array, so no two inputs share an encoding.
export const inputHash = (facts: PromptFacts): Effect.Effect<InputHash, never, Digest.Digest> =>
  Effect.flatMap(Digest.Digest, (digest) =>
    digest.digestHex(
      Digest.sha256,
      utf8.encode(
        JSON.stringify([
          inputVersion,
          facts.readmeOid,
          facts.fullName,
          facts.description,
          facts.topics,
          facts.language,
        ]),
      ),
    ),
  ).pipe(Effect.map(InputHash.make));
