import { loginKey } from "@stargrep/github/login";
import { useEffect, useState } from "react";
import { api, type SimilarPerson } from "./rpc.ts";

// As many people as the people tab asks for, so the two share one cached answer.
const asked = 12;

const answers = new Map<string, Promise<ReadonlyArray<SimilarPerson>>>();

// The people with stars most like a login's, asked once per page load and only once something shows them. A failed or
// unread answer is nobody, and the next page load asks again.
export function useSimilarPeople(login: string): ReadonlyArray<SimilarPerson> | undefined {
  const key = loginKey(login);
  const [landed, setLanded] = useState<{ readonly key: string; readonly people: ReadonlyArray<SimilarPerson> }>();
  useEffect(() => {
    let answer = answers.get(key);
    if (answer === undefined) {
      answer = api()
        .similarPeople({ login, limit: asked })
        .then(
          (similar) => similar.people,
          () => [],
        );
      answers.set(key, answer);
    }
    let current = true;
    void answer.then((people) => {
      if (current) setLanded({ key, people });
    });
    return () => {
      current = false;
    };
  }, [key, login]);
  return landed?.key === key ? landed.people : undefined;
}

// The faces to ask the same question of: the people most alike, with up to `followed` of those the viewer follows kept
// in, last, so a row always has room for people the viewer chose.
export const sameQuestionFaces = <P extends { readonly login: string }>(
  people: ReadonlyArray<P>,
  isFollowing: (login: string) => boolean,
  shown: number,
  followed: number,
): ReadonlyArray<P> => {
  const yours = people.filter((person) => isFollowing(person.login)).slice(0, followed);
  const others = people.filter((person) => !isFollowing(person.login)).slice(0, shown - yours.length);
  return [...others, ...yours];
};
