import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { GraphQLError } from "./schemas.ts";

export const envelope = <S extends Schema.Top>(data: S) =>
  Schema.Struct({
    data: Schema.optionalKey(Schema.NullOr(data)),
    errors: Schema.optionalKey(Schema.Array(GraphQLError)),
  });

// A body that is not JSON, such as the empty 200 GitHub sends when it cuts a query off at its time limit, is no
// answer at all, so it is told apart from JSON that does not match the envelope.
export const parse = (raw: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(raw));
  } catch {
    return Option.none();
  }
};

export const operation = <A>(document: string, data: Schema.Decoder<A>) => ({
  decode: Schema.decodeUnknownEffect(envelope(data)),
  request: (variables: Readonly<Record<string, unknown>>) =>
    HttpClientRequest.post("https://api.github.com/graphql").pipe(
      HttpClientRequest.bodyJsonUnsafe({ query: document, variables }),
    ),
});

export const decodeErrors = Schema.decodeUnknownOption(Schema.fromJsonString(envelope(Schema.Unknown)));
