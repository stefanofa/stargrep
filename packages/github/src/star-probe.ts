import type * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { GitHubAccountId, type GraphQLError, type Login } from "./schemas.ts";

// An account the probe asks about, by the login it synced under.
export interface Target {
  readonly id: GitHubAccountId;
  readonly login: Login;
}

// What GitHub said about one account: how many repos it stars, and when it starred the newest one.
export interface Probed {
  readonly id: GitHubAccountId;
  readonly starredTotal: number;
  readonly newestStarredAt: Option.Option<DateTime.Utc>;
}

export interface Answer {
  readonly probed: ReadonlyArray<Probed>;
  // Logins GitHub no longer has, or that now name another account, such as one an account renamed away from.
  readonly missing: ReadonlyArray<GitHubAccountId>;
  // The GraphQL points GitHub charged.
  readonly cost: number;
}

// GitHub answers a request's aliases one after another and cuts the request off at 10 s, so a caller sizes batches by
// how long each account takes. This bounds a batch whatever its accounts.
export const maxBatch = 25;

const alias = (index: number) => `p${index}`;

// Each alias reads one star and the total. GitHub prices a request at one point, whatever its size.
export const query = (count: number) => {
  const variables = Array.from({ length: count }, (_, index) => `$l${index}: String!`);
  const lookups = Array.from(
    { length: count },
    (_, index) =>
      `  ${alias(index)}: user(login: $l${index}) { databaseId starredRepositories(first: 1, orderBy: { field: STARRED_AT, direction: DESC }) { totalCount edges { starredAt } } }`,
  );
  return `query StarProbe(${variables.join(", ")}) {\n  rateLimit { cost }\n${lookups.join("\n")}\n}`;
};

export const variables = (targets: ReadonlyArray<Target>) =>
  Object.fromEntries(targets.map((target, index) => [`l${index}`, target.login]));

export const Data = Schema.Record(Schema.String, Schema.Unknown);

const Node = Schema.Struct({
  databaseId: GitHubAccountId,
  starredRepositories: Schema.Struct({
    totalCount: Schema.Int,
    edges: Schema.Array(Schema.Struct({ starredAt: Schema.DateTimeUtcFromString })),
  }),
});
const decodeNode = Schema.decodeUnknownResult(Node);
const decodeCost = Schema.decodeUnknownOption(Schema.Struct({ cost: Schema.Int }));

// A login GitHub no longer has fails only its own alias, and so does any other error GitHub scopes to one alias.
export const isAliasError = (error: GraphQLError) => {
  const [field] = error.path ?? [];
  return typeof field === "string" && /^p\d+$/.test(field);
};

// Keeps an answer only when GitHub's databaseId is the account's, so a login another account took never lends that
// account's stars. An alias with no answer, or one the decoder refuses, counts as missing.
export const settle = (targets: ReadonlyArray<Target>, data: typeof Data.Type): Answer => {
  const probed: Array<Probed> = [];
  const missing: Array<GitHubAccountId> = [];
  for (const [index, target] of targets.entries()) {
    const node = decodeNode(data[alias(index)]);
    if (Result.isFailure(node) || node.success.databaseId !== target.id) {
      missing.push(target.id);
      continue;
    }
    const stars = node.success.starredRepositories;
    probed.push({
      id: target.id,
      starredTotal: stars.totalCount,
      newestStarredAt: Option.map(Option.fromUndefinedOr(stars.edges[0]), (edge) => edge.starredAt),
    });
  }
  const cost = Option.match(decodeCost(data.rateLimit), { onNone: () => 0, onSome: (found) => found.cost });
  return { probed, missing, cost };
};
