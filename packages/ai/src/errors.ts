import * as Schema from "effect/Schema";

export const Operation = Schema.Literals(["generate", "embed"]);
export type Operation = typeof Operation.Type;

export class AiModelNotFound extends Schema.TaggedError<AiModelNotFound>()("AiModelNotFound", {
  model: Schema.String,
}) {
  override get message(): string {
    return `Model '${this.model}' is not available from this provider`;
  }
}

export class AiOutputInvalid extends Schema.TaggedError<AiOutputInvalid>()("AiOutputInvalid", {
  operation: Operation,
  model: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Model '${this.model}' returned output that does not match the expected shape in '${this.operation}': ${this.detail}`;
  }
}

// The model declined to answer the prompt, such as when its safeguards flagged it. The same prompt gets the same
// refusal, so a refusal is the prompt's own failure, and asking again only pays for it again.
export class AiRefused extends Schema.TaggedError<AiRefused, { readonly brand: unique symbol }>()("AiRefused", {
  operation: Operation,
  model: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Model '${this.model}' refused to answer '${this.operation}': ${this.detail}`;
  }
}

export class AiTimeout extends Schema.TaggedError<AiTimeout>()("AiTimeout", {
  operation: Operation,
  model: Schema.String,
  timeoutMillis: Schema.Finite,
}) {
  override get message(): string {
    return `Model '${this.model}' did not answer '${this.operation}' within ${this.timeoutMillis} ms`;
  }
}

export class AiRequestFailed extends Schema.TaggedError<AiRequestFailed>()("AiRequestFailed", {
  operation: Operation,
  model: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Model '${this.model}' request failed in '${this.operation}': ${this.detail}`;
  }
}

export class AiUnavailable extends Schema.TaggedError<AiUnavailable>()("AiUnavailable", {
  operation: Operation,
  model: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Model '${this.model}' is unavailable for '${this.operation}' and may answer a retry: ${this.detail}`;
  }
}

export class AiKeyMissing extends Schema.TaggedError<AiKeyMissing, { readonly brand: unique symbol }>()(
  "AiKeyMissing",
  {
    operation: Operation,
    model: Schema.String,
  },
) {
  override get message(): string {
    return `No AI Gateway key is configured, so model '${this.model}' cannot run '${this.operation}'`;
  }
}

export type AiError =
  | AiModelNotFound
  | AiOutputInvalid
  | AiRefused
  | AiTimeout
  | AiRequestFailed
  | AiUnavailable
  | AiKeyMissing;
