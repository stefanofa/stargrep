import * as Config from "effect/Config";
import * as Schema from "effect/Schema";

export const serverTokenName = "STARGREP_GITHUB_SERVER_TOKEN";

export const ServerTokenKind = Schema.Literals(["app", "pat"]);
export type ServerTokenKind = typeof ServerTokenKind.Type;

// Which token the server reads GitHub with: the Stargrep App's installation token or a personal token. The prod deploy
// passes app unless the repository variable says pat, so going back to the personal token takes a variable and a
// deploy, not a code change. Other stages read with a personal token. Actions passes an unset variable as an empty
// string. Each Worker binds the kind it deployed with, so it reads the same kind when it starts.
export const serverTokenKind: Config.Config<ServerTokenKind> = Config.schema(
  Schema.Literals(["app", "pat", ""]),
  serverTokenName,
).pipe(
  Config.withDefault(""),
  Config.map((kind) => (kind === "" ? "pat" : kind)),
);
