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

export type AiError = AiModelNotFound | AiOutputInvalid | AiTimeout | AiRequestFailed;
