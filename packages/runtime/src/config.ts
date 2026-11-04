import { apiKeyName } from "@stargrep/ai/gateway";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

// Actions passes a secret that is not set as an empty string, and the process environment keeps it.
export const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(Config.option, Config.map(Option.filter((value) => Redacted.value(value) !== "")));

export const aiGatewayKey = optionalSecret(apiKeyName);
