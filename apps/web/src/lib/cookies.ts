// The server reads these cookies when it renders a page, so the choices they hold paint on the first frame. A value
// with a broken percent escape counts as no cookie, so a stray value never fails a page.
export const cookieValue = (cookies: string | null, name: string) => {
  const value = cookies?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1];
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

export const setCookie = (name: string, value: string, maxAge: number) => {
  // biome-ignore lint/suspicious/noDocumentCookie: the server reads this cookie when it renders the page, so it can't live in storage.
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
};
