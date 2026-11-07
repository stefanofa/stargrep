import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

// Actions represents an unset secret or variable with an empty string.
export const optionalText = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.filter((value) => value !== "")));
export const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(Config.option, Config.map(Option.filter((value) => Redacted.value(value) !== "")));
export const requiredSecret = (name: string) => Config.schema(Schema.Redacted(Schema.NonEmptyString), name);

export const githubClientIdName = "STARGREP_GITHUB_APP_CLIENT_ID";
