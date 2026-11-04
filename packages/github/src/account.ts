import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { type Account, GitHubAccountId, Login } from "./schemas.ts";

const User = Schema.Struct({
  id: GitHubAccountId,
  login: Login,
  type: Schema.Literals(["User", "Organization"]),
  name: Schema.NullOr(Schema.String),
  avatar_url: Schema.NullOr(Schema.String),
  followers: Schema.Int,
  public_repos: Schema.Int,
});

export const decodeUser = Schema.decodeEffect(Schema.fromJsonString(User));

export const toAccount = (user: typeof User.Type): Account => ({
  id: user.id,
  login: user.login,
  type: user.type === "User" ? "user" : "org",
  name: user.name,
  avatarUrl: user.avatar_url,
  followers: user.followers,
  publicRepos: user.public_repos,
});

export const request = (login: Login) =>
  HttpClientRequest.get(`https://api.github.com/users/${encodeURIComponent(login)}`).pipe(
    HttpClientRequest.accept("application/vnd.github+json"),
  );
