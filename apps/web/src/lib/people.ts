import { loginKey } from "@stargrep/github/login";
import { useEffect, useRef, useState } from "react";
import { api, type People, type PeopleSort, type Person, type SimilarPerson } from "./rpc.ts";

// What /people knows when it paints: the first page of the list, or that the API refused it.
export type FirstPeople = { readonly kind: "found"; readonly page: People } | { readonly kind: "failed" };

export const firstPeople = (sort: PeopleSort): Promise<FirstPeople> =>
  api()
    .people({ sort })
    .then(
      (page): FirstPeople => ({ kind: "found", page }),
      (): FirstPeople => ({ kind: "failed" }),
    );

// The people shown so far, and whether "show more" is asking for the next page or failed to get it.
export interface Shown {
  readonly people: ReadonlyArray<Person>;
  readonly next: number | null;
  readonly more: "idle" | "asking" | "failed";
}

const shownOf = (page: People): Shown => ({ people: page.people, next: page.nextOffset, more: "idle" });

// Pages the list from its first page. A new first page, such as another sort, starts over.
export const usePeoplePages = (first: People) => {
  const [state, setState] = useState({ first, shown: shownOf(first) });
  if (state.first !== first) setState({ first, shown: shownOf(first) });
  const { shown } = state;
  const showMore = () => {
    if (shown.next === null || shown.more === "asking") return;
    const update = (next: (previous: Shown) => Shown) =>
      setState((previous) => (previous.first === first ? { first, shown: next(previous.shown) } : previous));
    update((previous) => ({ ...previous, more: "asking" }));
    api()
      .people({ sort: first.sort, offset: shown.next })
      .then(
        (page) =>
          update((previous) => ({
            // The list can change between pages, so a person already shown is not shown twice.
            people: [
              ...previous.people,
              ...page.people.filter((person) => !previous.people.some((seen) => seen.login === person.login)),
            ],
            next: page.nextOffset,
            more: "idle",
          })),
        () => update((previous) => ({ ...previous, more: "failed" })),
      );
  };
  return { shown, showMore };
};

// The people whose stars are most like a login's, asked once per login when the page first shows its library. Undefined
// until the answer lands. A login with no one alike, one that hasn't synced, or a refused ask has no one.
export const useSimilarPeople = (
  login: string,
  limit: number,
  visible: boolean,
): ReadonlyArray<SimilarPerson> | undefined => {
  const key = `${loginKey(login)}:${limit}`;
  const [answer, setAnswer] = useState<{ readonly key: string; readonly people: ReadonlyArray<SimilarPerson> }>();
  const asked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!visible || asked.current === key) return;
    asked.current = key;
    api()
      .similarPeople({ login, limit })
      .then(
        ({ people }) => people,
        (): ReadonlyArray<SimilarPerson> => [],
      )
      .then((people) => setAnswer({ key, people }));
  }, [login, limit, key, visible]);
  return answer?.key === key ? answer.people : undefined;
};
