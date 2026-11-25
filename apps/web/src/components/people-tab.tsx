import { buttonVariants, Chip, EmptyTile, Skeleton } from "@stargrep/ui";
import { getRouteApi, Link, useLoaderData } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useFollows } from "../lib/follows.ts";
import type { Session } from "../lib/page-data.ts";
import { api, type SimilarPerson } from "../lib/rpc.ts";
import { wallNow } from "../lib/wall-clock.ts";
import { PersonCard, PersonCardPlaceholder } from "./person-card.tsx";
import { loadTab, mostlyIn, TabLoading, TabPage } from "./person-tab.tsx";

const route = getRouteApi("/@{$login}_/people");

// The most people the tab shows, as many as similarPeople answers.
const shown = 12;

// How many of the login's own topics the "into" chips offer.
const intoShown = 3;

const grid = "grid gap-3 sm:grid-cols-2 sm:gap-gap lg:grid-cols-4";

// The people with stars most like a login's, into a topic or any.
export const load = (login: string, session: Session | undefined, { topic }: { topic?: string | undefined }) =>
  loadTab(
    "people",
    login,
    session,
    (): Promise<ReadonlyArray<SimilarPerson>> =>
      api()
        .similarPeople({ login, limit: shown, ...(topic === undefined ? {} : { topic }) })
        .then((similar) => similar.people),
    (named) => ({
      title: `people like @${named}`,
      description: `The developers whose GitHub stars are most like @${named}'s, and how many stars they share.`,
    }),
  );

const chip = "h-[30px] shrink-0 px-[13px]";

// The topics to narrow the people to: the login's own top topics, and the one the address names when it isn't one of
// them, so a shared link can take it back off.
function Into({ topics, topic }: { topics: ReadonlyArray<string>; topic: string | undefined }) {
  const offered = topic === undefined || topics.includes(topic) ? topics : [...topics, topic];
  if (offered.length === 0) return null;
  return (
    <nav
      aria-label="people into a topic"
      className="flex items-center gap-2 max-sm:-mx-5 max-sm:overflow-x-auto max-sm:px-5 max-sm:[mask-image:linear-gradient(to_left,transparent,#000_16px)] max-sm:[scrollbar-width:none] sm:flex-wrap"
    >
      <span className="shrink-0 pr-1 font-sans text-meta text-muted-foreground">into</span>
      <Chip
        className={chip}
        active={topic === undefined}
        render={<Link to="." search={{ topic: undefined }} activeOptions={{ explicitUndefined: true }} />}
      >
        any
      </Chip>
      {offered.map((name) => (
        <Chip key={name} className={chip} active={topic === name} render={<Link to="." search={{ topic: name }} />}>
          {name}
        </Chip>
      ))}
    </nav>
  );
}

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-1 pt-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-display text-xl leading-8 font-semibold tracking-snug sm:text-[28px]">{title}</h2>
        <p className="font-sans text-meta text-muted-foreground">most alike first</p>
      </div>
      {children}
    </div>
  );
}

// Nobody shares a star with the login, on the topic or at all. A topic leaves the chips above to pick another.
function Nobody({ login, own, topic }: { login: string; own: boolean; topic: string | undefined }) {
  const whom = own ? "you" : `@${login}`;
  return topic === undefined ? (
    <EmptyTile
      pose="unsure"
      heading={`nobody shares a star with ${whom} yet`}
      body="stargrep compares stars with the people on its list, and it grows every night."
    >
      <Link to="/people" className={`${buttonVariants({ variant: "primary", size: "lg" })} mt-2`}>
        see everyone
      </Link>
    </EmptyTile>
  ) : (
    <EmptyTile
      pose="unsure"
      heading={`nobody into ${topic} shares a star with ${whom} yet`}
      body="pick another topic, or any."
    />
  );
}

// The person, then the people with stars most like theirs. "you follow" on a card shows only to you.
export function Page() {
  const { login, own, state } = route.useLoaderData();
  const { topic } = route.useSearch();
  const { viewer } = useLoaderData({ from: "__root__" });
  const follows = useFollows(viewer !== null);
  const [at] = useState(wallNow);
  return (
    <TabPage
      tab="people"
      login={login}
      own={own}
      state={state}
      words={
        own
          ? { what: "people like you", shows: "people with stars like yours show here" }
          : { what: `people like @${login}`, shows: "people with stars like theirs show here" }
      }
    >
      {(taste, people) => (
        <>
          <Heading title={own ? "stars like yours" : `stars like @${login}'s`}>
            <Into topics={mostlyIn(taste).slice(0, intoShown)} topic={topic} />
          </Heading>
          {people.length === 0 ? (
            <Nobody login={login} own={own} topic={topic} />
          ) : (
            <ol aria-label="people" className={grid}>
              {people.map((person) => (
                <li key={person.login} className="flex min-w-0 flex-col *:flex-1">
                  <PersonCard person={person} following={follows.isFollowing(person.login)} at={at} />
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </TabPage>
  );
}

// The page as it will stand, with a placeholder per card.
export function Loading() {
  const { login } = route.useParams();
  return (
    <TabLoading tab="people" login={login}>
      <div className="flex flex-col gap-3 px-1 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-[30px] w-60 rounded-full" />
      </div>
      <div aria-hidden className={grid}>
        {Array.from({ length: 8 }, (_, index) => (
          <PersonCardPlaceholder key={index} />
        ))}
      </div>
    </TabLoading>
  );
}
