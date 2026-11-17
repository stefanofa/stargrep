const send = (path: string, init?: RequestInit) =>
  // @effect-diagnostics-next-line globalFetch:off - Better Auth answers plain HTTP, and public pages load no Effect.
  fetch(path, { credentials: "same-origin", ...init });

const post = (path: string, body: object = {}) =>
  send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// Sign-in returns to the page it started from, without the error of an earlier try. Better Auth refuses a path that
// starts with two slashes, which reads as another host.
const here = () => {
  const url = new URL(location.href);
  url.searchParams.delete("error");
  return `${url.pathname.replace(/^\/+/, "/")}${url.search}`;
};

export const signIn = async () => {
  const back = here();
  const response = await post("/auth/sign-in/social", {
    provider: "github",
    callbackURL: back,
    errorCallbackURL: back,
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
