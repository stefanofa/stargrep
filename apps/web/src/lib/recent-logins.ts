import { isGitHubLogin } from "@stargrep/github/login";
import { sameLogin } from "./whose.ts";

const key = "stargrep:recent-logins";
const kept = 5;

// The logins this browser looked at last, newest first. Storage can be missing or refuse access, such as in a private
// window, and then there are none.
export const recentLogins = (): ReadonlyArray<string> => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(stored) ? stored.filter((login) => typeof login === "string" && isGitHubLogin(login)) : [];
  } catch {
    return [];
  }
};

export const rememberLogin = (login: string) => {
  try {
    const next = [login, ...recentLogins().filter((other) => !sameLogin(other, login))].slice(0, kept);
    localStorage.setItem(key, JSON.stringify(next));
  } catch {}
};
