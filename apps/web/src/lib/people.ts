import { useState } from "react";
import { api, type People, type PeopleSort, type Person } from "./rpc.ts";

// What discover's people know when they paint: the first page of the list, or that the API refused it.
export type FirstPeople = { readonly kind: "found"; readonly page: People } | { readonly kind: "failed" };

// The list in one order, and into one topic or any.
export interface PeopleAsked {
  readonly sort: PeopleSort;
  readonly topic?: string | undefined;
}

const input = ({ sort, topic }: PeopleAsked) => (topic === undefined ? { sort } : { sort, topic });

export const firstPeople = (asked: PeopleAsked): Promise<FirstPeople> =>
  api()
    .people(input(asked))
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

// Pages the list from its first page. A new first page, such as another sort or topic, starts over.
export const usePeoplePages = (first: People, asked: PeopleAsked) => {
  const [state, setState] = useState({ first, shown: shownOf(first) });
  if (state.first !== first) setState({ first, shown: shownOf(first) });
  const { shown } = state;
  const showMore = () => {
    if (shown.next === null || shown.more === "asking") return;
    const update = (next: (previous: Shown) => Shown) =>
      setState((previous) => (previous.first === first ? { first, shown: next(previous.shown) } : previous));
    update((previous) => ({ ...previous, more: "asking" }));
    api()
      .people({ ...input(asked), offset: shown.next })
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
