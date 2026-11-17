import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Login, RepoId, RepoName, RepoNodeId, type Star } from "./schemas.ts";

// The list's metadata only fills in what enrichment reads later, so an item that leaves it out still decodes.
const StarItem = Schema.Struct({
  starred_at: Schema.DateTimeUtcFromString,
  repo: Schema.Struct({
    id: RepoId,
    node_id: RepoNodeId,
    name: RepoName,
    full_name: Schema.TemplateLiteralParser([Login, "/", RepoName]),
    // Null when GitHub no longer shows the owner's account. full_name still names the owner.
    owner: Schema.NullOr(Schema.Struct({ login: Login })),
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    topics: Schema.optionalKey(Schema.Array(Schema.String)),
    language: Schema.optionalKey(Schema.NullOr(Schema.String)),
    stargazers_count: Schema.optionalKey(Schema.Int),
  }),
});
type StarItem = typeof StarItem.Type;

export const decodeStarItems = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(StarItem)));

export const toStar = ({ starred_at, repo }: StarItem): Star => ({
  starredAt: starred_at,
  repo: {
    id: repo.id,
    nodeId: repo.node_id,
    owner: repo.owner?.login ?? repo.full_name[0],
    name: repo.name,
    description: repo.description ?? null,
    topics: repo.topics ?? [],
    language: repo.language ?? null,
    stars: repo.stargazers_count ?? null,
  },
});

export const request = (login: Login, page: number) =>
  HttpClientRequest.get(`https://api.github.com/users/${encodeURIComponent(login)}/starred`).pipe(
    HttpClientRequest.setUrlParams({ sort: "created", direction: "desc", per_page: "100", page: String(page) }),
    HttpClientRequest.accept("application/vnd.github.star+json"),
  );

// GitHub answers any page past this one with 422, "pagination is limited for this resource", whatever the list holds.
export const lastPage = 400;

const nextLink = /<([^>]*)>;\s*rel="next"/;
const pageNumber = /^[1-9]\d*$/;

export const nextPage = (link: string | undefined): Result.Result<Option.Option<number>, "invalid-link"> => {
  const target = link?.match(nextLink)?.[1];
  if (target === undefined) return Result.succeed(Option.none());
  const page = URL.parse(target)?.searchParams.get("page");
  return page != null && pageNumber.test(page)
    ? Result.succeed(Option.some(Number(page)))
    : Result.fail("invalid-link");
};
