import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { GraphQLError } from "./schemas.ts";

export const envelope = <S extends Schema.Top>(data: S) =>
  Schema.Struct({
    data: Schema.optionalKey(Schema.NullOr(data)),
    errors: Schema.optionalKey(Schema.Array(GraphQLError)),
  });

export const operation = <A>(document: string, data: Schema.Decoder<A>) => ({
  decode: Schema.decodeEffect(Schema.fromJsonString(envelope(data))),
  request: (variables: Readonly<Record<string, unknown>>) =>
    HttpClientRequest.post("https://api.github.com/graphql").pipe(
      HttpClientRequest.bodyJsonUnsafe({ query: document, variables }),
    ),
});

export const decodeErrors = Schema.decodeUnknownOption(Schema.fromJsonString(envelope(Schema.Unknown)));
