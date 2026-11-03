import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AiError } from "./errors.ts";
import type { AiSchema } from "./schema-bridge.ts";

export interface GenerateRequest<A> {
  readonly schema: AiSchema<A>;
  readonly system: string;
  readonly prompt: string;
}

export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    readonly model: string;
    readonly generate: <A>(request: GenerateRequest<A>) => Effect.Effect<A, AiError>;
  }
>()("@stargrep/ai/text-generation/TextGeneration") {}
