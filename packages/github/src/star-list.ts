import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { Login, RepoId, RepoName, RepoNodeId, type Star } from "./schemas.ts";

export interface StarPage {
  readonly stars: ReadonlyArray<Star>;
  readonly next: number | null;
}

const StarItem = Schema.Struct({
  starred_at: Schema.DateTimeUtcFromString,
  repo: Schema.Struct({
    id: RepoId,
    node_id: RepoNodeId,
    name: RepoName,
    owner: Schema.Struct({ login: Login }),
  }),
});

export const decodeStarItems = Schema.decodeUnknownEffect(Schema.Array(StarItem));
type StarItem = typeof StarItem.Type;

export const request = (login: Login, page: number) =>
  HttpClientRequest.get(`https://api.github.com/users/${encodeURIComponent(login)}/starred`).pipe(
    HttpClientRequest.setUrlParams({ sort: "created", direction: "desc", per_page: "100", page: String(page) }),
    HttpClientRequest.accept("application/vnd.github.star+json"),
  );

const nextLink = /<([^>]+)>;\s*rel="next"/;

export const nextPage = (link: string | undefined): number | null => {
  const url = link?.match(nextLink)?.[1];
  const page = url === undefined ? null : new URL(url).searchParams.get("page");
  return page === null ? null : Number(page);
};

export const toPage = (items: ReadonlyArray<StarItem>, link: string | undefined): StarPage => ({
  stars: items.map((item) => ({
    starredAt: item.starred_at,
    repo: { id: item.repo.id, nodeId: item.repo.node_id, owner: item.repo.owner.login, name: item.repo.name },
  })),
  next: nextPage(link),
});
