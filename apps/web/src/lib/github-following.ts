import { useEffect, useState } from "react";
import { api, type GitHubFollowing, wireCode } from "./rpc.ts";
import { wallNow } from "./wall-clock.ts";

const importKey = (login: string) => `stargrep-github-following:${login.toLowerCase()}`;
const importKept = 86_400_000;

// The GitHub following read keeps for a day in this browser, since the API reads it once a day.
const keptImport = (login: string): GitHubFollowing | undefined => {
  try {
    const raw = localStorage.getItem(importKey(login));
    if (raw === null) return undefined;
    const kept = JSON.parse(raw) as { readonly at: number; readonly answer: GitHubFollowing };
    return wallNow() - kept.at < importKept ? kept.answer : undefined;
  } catch {
    return undefined;
  }
};

const keepImport = (login: string, answer: GitHubFollowing) => {
  try {
    localStorage.setItem(importKey(login), JSON.stringify({ at: wallNow(), answer }));
  } catch {}
};

type Import =
  | { readonly kind: "reading" }
  | { readonly kind: "found"; readonly answer: GitHubFollowing }
  | { readonly kind: "refused"; readonly limited: boolean };

// Whom the viewer follows on GitHub who is on stargrep, read once a day.
export const useGitHubFollowing = (login: string) => {
  const [state, setState] = useState<Import>({ kind: "reading" });
  useEffect(() => {
    const kept = keptImport(login);
    if (kept !== undefined) {
      setState({ kind: "found", answer: kept });
      return;
    }
    let current = true;
    api()
      .githubFollowing()
      .then(
        (answer) => {
          keepImport(login, answer);
          if (current) setState({ kind: "found", answer });
        },
        (error: unknown) => {
          if (current) setState({ kind: "refused", limited: wireCode(error) === "TOO_MANY_REQUESTS" });
        },
      );
    return () => {
      current = false;
    };
  }, [login]);
  return state;
};
