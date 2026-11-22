import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { GitHubAccountId, Login } from "./schemas.ts";

// GitHub lists an account's following 100 to a page. Ten pages hold the first 1,000, as many as one person may follow.
export const lastPage = 10;

const FollowingItem = Schema.Struct({ id: GitHubAccountId, login: Login, type: Schema.String });

export const decodeFollowing = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(FollowingItem)));

export interface Followed {
  readonly id: GitHubAccountId;
  readonly login: Login;
}

// Only users star repos, so an org the account follows is left out.
export const toFollowed = (items: ReadonlyArray<typeof FollowingItem.Type>): ReadonlyArray<Followed> =>
  items.flatMap((item) => (item.type === "User" ? [{ id: item.id, login: item.login }] : []));

export const request = (login: Login, page: number) =>
  HttpClientRequest.get(`https://api.github.com/users/${encodeURIComponent(login)}/following`).pipe(
    HttpClientRequest.setUrlParams({ per_page: "100", page: String(page) }),
  );
