import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const Operation = Schema.Literals(["list-stars", "repo-facts", "readme"]);
export type Operation = typeof Operation.Type;

export class NotFound extends Schema.TaggedError<NotFound, { readonly brand: unique symbol }>()("NotFound", {
  operation: Operation,
  path: Schema.String,
}) {
  override get message(): string {
    return `GitHub '${this.operation}' found nothing at ${this.path}`;
  }
}

export class Unauthorized extends Schema.TaggedError<Unauthorized, { readonly brand: unique symbol }>()(
  "Unauthorized",
  {
    operation: Operation,
  },
) {
  override get message(): string {
    return `GitHub rejected the token for '${this.operation}'`;
  }
}

export class RateLimited extends Schema.TaggedError<RateLimited, { readonly brand: unique symbol }>()("RateLimited", {
  operation: Operation,
  resource: Schema.String,
  retryAfterMillis: Schema.Int,
}) {
  override get message(): string {
    return `GitHub rate limited '${this.operation}' on '${this.resource}' for ${this.retryAfterMillis} ms`;
  }
}

export class TokenBudgetExhausted extends Schema.TaggedError<TokenBudgetExhausted, { readonly brand: unique symbol }>()(
  "TokenBudgetExhausted",
  {
    resource: Schema.String,
    resetAt: Schema.Int,
  },
) {
  override get message(): string {
    return `The token's budget share for '${this.resource}' is spent until ${DateTime.formatIso(DateTime.makeUnsafe(this.resetAt))}`;
  }
}

export class GitHubRequestFailed extends Schema.TaggedError<GitHubRequestFailed, { readonly brand: unique symbol }>()(
  "GitHubRequestFailed",
  {
    operation: Operation,
    status: Schema.NullOr(Schema.Int),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GitHub '${this.operation}' failed${this.status === null ? "" : ` with status ${this.status}`}`;
  }
}

export class GitHubResponseInvalid extends Schema.TaggedError<
  GitHubResponseInvalid,
  { readonly brand: unique symbol }
>()("GitHubResponseInvalid", {
  operation: Operation,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `GitHub '${this.operation}' returned a response that does not match its schema`;
  }
}

export type GitHubError =
  | NotFound
  | Unauthorized
  | RateLimited
  | TokenBudgetExhausted
  | GitHubRequestFailed
  | GitHubResponseInvalid;
