import { loginKey } from "@stargrep/github/login";
import { useEffect, useRef, useState } from "react";
import { api, type SimilarRepos } from "./rpc.ts";

export type Similar = SimilarRepos | "loading" | undefined;

// The repos near the one the panel shows, asked for only once a repo is open. Undefined with no repo, or when the
// answer failed, so the panel shows no rows. The page keeps each answer, so a repo opened again shows its rows at once,
// and drops a failed one, so the next open asks again.
export function useSimilar(login: string, id: number | undefined): Similar {
  const key = id === undefined ? undefined : `${loginKey(login)}/${id}`;
  const answers = useRef(new Map<string, Promise<SimilarRepos | undefined>>());
  const [landed, setLanded] = useState<{ readonly key: string; readonly answer: SimilarRepos | undefined }>();
  useEffect(() => {
    if (key === undefined || id === undefined) return;
    const kept = answers.current;
    let answer = kept.get(key);
    if (answer === undefined) {
      answer = api()
        .similarRepos({ login, id })
        .catch(() => {
          kept.delete(key);
          return undefined;
        });
      kept.set(key, answer);
    }
    let current = true;
    void answer.then((landing) => {
      if (current) setLanded({ key, answer: landing });
    });
    return () => {
      current = false;
    };
  }, [key, login, id]);
  if (key === undefined) return undefined;
  return landed?.key === key ? landed.answer : "loading";
}
