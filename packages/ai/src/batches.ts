import type { JSONSchema7 } from "ai";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { AiError } from "./errors.ts";
import type { RunResult } from "./text-generation.ts";

// One provider batch request, exactly as it is sent: the model, the system prompt, the provider schema, and the
// prompts in order. A caller that stores it can send the same bytes again after a crash. attempt is set on a second
// batch for prompts the first answered badly, so it gets its own idempotency key even when it asks every prompt again.
export const BatchRequest = Schema.Struct({
  model: Schema.String,
  system: Schema.String,
  // The provider reads the schema as opaque JSON, so it is kept as it was written.
  jsonSchema: Schema.declare((input): input is JSONSchema7 => typeof input === "object" && input !== null),
  prompts: Schema.Array(Schema.String),
  attempt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(1))),
});
export type BatchRequest = typeof BatchRequest.Type;

const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeUnknownEffect(Json);

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

// The idempotency key of a request: a hash of the model, system, schema, and prompts in order, and the attempt when it
// has one. The Gateway replays a batch start that repeats a key with the same body, so a run that dies while it waits
// finds its batch again instead of paying for it twice.
export const requestKey = (request: BatchRequest) =>
  encodeJson([
    request.model,
    request.system,
    request.jsonSchema,
    request.prompts,
    ...(request.attempt === undefined ? [] : [request.attempt]),
  ]).pipe(
    Effect.orDie,
    Effect.flatMap((text) => Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))),
    Effect.map((digest) => `stargrep-batch-${toHex(digest)}`),
  );

// The raw answer to item i of a batch, or undefined when the provider returned none for it.
export type BatchItems = ReadonlyArray<Result.Result<RunResult, AiError> | undefined>;

// What collecting a batch found. Answered holds every item. Failed means the provider failed the batch itself, so it
// will answer nothing more. Unknown means the provider has no batch with that ID. Any other failure is an error, and
// says nothing about the batch.
export type Collected = Data.TaggedEnum<{
  Answered: { readonly items: BatchItems };
  Failed: { readonly detail: string };
  Unknown: { readonly batchId: string };
}>;
export const Collected = Data.taggedEnum<Collected>();

// A provider's batch API, split where a caller must record the provider's batch ID before it waits. submit starts the
// batch, or finds the one an earlier submit of the same request started. collect waits for it to finish and reads
// every item. Neither decodes an answer, so the port's schema and the caller's fallback stay in one place.
export class Batches extends Context.Service<
  Batches,
  {
    readonly provider: string;
    readonly model: string;
    readonly submit: (request: BatchRequest) => Effect.Effect<string, AiError>;
    readonly collect: (batchId: string, size: number) => Effect.Effect<Collected, AiError>;
  }
>()("@stargrep/ai/batches") {}
