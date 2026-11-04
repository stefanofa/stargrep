import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { GraphQLError, type Login } from "./schemas.ts";

const query = `query StarCount($login: String!) {
  user(login: $login) { starredRepositories { totalCount } }
}`;

export const decodeResponse = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            user: Schema.NullOr(Schema.Struct({ starredRepositories: Schema.Struct({ totalCount: Schema.Int }) })),
          }),
        ),
      ),
      errors: Schema.optionalKey(Schema.Array(GraphQLError)),
    }),
  ),
);

export const request = (login: Login) =>
  HttpClientRequest.post("https://api.github.com/graphql").pipe(
    HttpClientRequest.bodyJsonUnsafe({ query, variables: { login } }),
  );
