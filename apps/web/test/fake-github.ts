export const ada = {
  code: "code-ada",
  token: "gho_ada",
  user: {
    id: 7,
    login: "ada",
    type: "User",
    name: "Ada Lovelace",
    avatar_url: "https://avatars.githubusercontent.com/u/7",
    followers: 10,
    public_repos: 3,
    email: null,
  },
  email: "ada@example.com",
  starredCount: 3,
};

export interface TokenExchange {
  readonly clientSecret: string | null;
  readonly redirectUri: string | null;
  readonly codeVerifier: boolean;
}

const exchanges: Array<TokenExchange> = [];
const viewerReads = { count: 0 };

const basicSecret = (authorization: string | null) =>
  authorization?.startsWith("Basic ") ? (atob(authorization.slice(6)).split(":")[1] ?? null) : null;

const signedIn = (request: Request) => request.headers.get("authorization") === `Bearer ${ada.token}`;

export const fakeGitHub = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.hostname === "fake-github.test") {
    const report = { exchanges: exchanges.splice(0), viewerReads: viewerReads.count };
    viewerReads.count = 0;
    return Response.json(report);
  }
  if (url.href === "https://github.com/login/oauth/access_token") {
    const form = new URLSearchParams(await request.text());
    exchanges.push({
      clientSecret: form.get("client_secret") ?? basicSecret(request.headers.get("authorization")),
      redirectUri: form.get("redirect_uri"),
      codeVerifier: form.has("code_verifier"),
    });
    return form.get("code") === ada.code
      ? Response.json({ access_token: ada.token, token_type: "bearer", scope: "", expires_in: 28_800 })
      : Response.json({ error: "bad_verification_code" });
  }
  if (!signedIn(request)) return Response.json({ message: "Bad credentials" }, { status: 401 });
  if (url.href === "https://api.github.com/user") return Response.json(ada.user);
  if (url.href === "https://api.github.com/user/emails") {
    return Response.json([{ email: ada.email, primary: true, verified: true }]);
  }
  if (url.href === "https://api.github.com/graphql") {
    viewerReads.count++;
    return Response.json({
      data: {
        viewer: {
          __typename: "User",
          databaseId: ada.user.id,
          login: ada.user.login,
          name: ada.user.name,
          avatarUrl: ada.user.avatar_url,
          followers: { totalCount: ada.user.followers },
          repositories: { totalCount: ada.user.public_repos },
          starredRepositories: { totalCount: ada.starredCount },
        },
      },
    });
  }
  return Response.json({ message: "Not Found" }, { status: 404 });
};
