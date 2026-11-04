const send = (path: string, init?: RequestInit) =>
  // @effect-diagnostics-next-line globalFetch:off - Better Auth answers plain HTTP, and public pages load no Effect.
  fetch(path, { credentials: "same-origin", ...init });

const post = (path: string, body: object = {}) =>
  send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const signIn = async () => {
  const response = await post("/auth/sign-in/social", {
    provider: "github",
    callbackURL: "/search",
    errorCallbackURL: "/",
  });
  if (!response.ok) throw new Error(`Sign-in answered ${response.status}`);
  const { url } = (await response.json()) as { readonly url: string };
  location.assign(url);
};

export const signOut = async () => {
  await post("/auth/sign-out");
  location.assign("/");
};

export const signedIn = async () => {
  const response = await send("/auth/get-session");
  return response.ok && (await response.json()) !== null;
};
