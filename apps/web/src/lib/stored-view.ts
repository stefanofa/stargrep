import { isView, type View } from "@stargrep/ui";
import { useCallback, useState } from "react";
import { cookieValue, setCookie } from "./cookies.ts";

const name = "stargrep-view";
const year = 365 * 24 * 60 * 60;

export const storedView = (cookies: string | null): View | undefined => {
  const value = cookieValue(cookies, name);
  return isView(value) ? value : undefined;
};

// The view a visitor last picked, kept in a cookie, so the server paints it and a reload moves nothing.
export function useStoredView(initial: View) {
  const [view, setView] = useState(initial);
  const update = useCallback((next: View) => {
    setView(next);
    setCookie(name, next, year);
  }, []);
  return [view, update] as const;
}
