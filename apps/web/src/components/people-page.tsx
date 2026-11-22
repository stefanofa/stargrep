import { Button, Chip, EmptyTile, LanguageBar, Skeleton, Tile } from "@stargrep/ui";
import { Link, useLoaderData, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { avatarOf } from "../lib/avatar.ts";
import { type FirstPeople, usePeoplePages } from "../lib/people.ts";
import { starredOn } from "../lib/present.ts";
import type { People, PeopleSort, Person } from "../lib/rpc.ts";
import { loginPage } from "../lib/stars-route.ts";
import { formatCount, starCount } from "../lib/whose.ts";
import { LoginField } from "./landing-hero.tsx";
import { Page } from "./page.tsx";
import { SiteHeader } from "./site-header.tsx";

const grid = "grid gap-gap sm:grid-cols-2 lg:grid-cols-4";
const cardBox = "flex min-w-0 flex-col gap-4 pt-6 pr-tile-sm pb-tile-sm pl-6";

// One person on the list: who, how many stars, what their stars are about, and when they last starred. The whole card
// opens their stars.
function PersonCard({ person }: { person: Person }) {
  return (
    <Tile className={cardBox}>
      <div className="flex min-w-0 items-center gap-3.5">
        <img
          src={avatarOf(person.login, 56)}
          alt=""
          width={56}
          height={56}
          loading="lazy"
          className="size-14 shrink-0 rounded-full bg-accent-soft outline-1 -outline-offset-1 outline-image-edge"
        />
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate font-display text-title font-semibold tracking-snug">
            <Link
              {...loginPage(person.login)}
              className="rounded-sm outline-none after:absolute after:inset-0 after:squircle after:rounded-tile focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
            >
              {`@${person.login}`}
            </Link>
          </h2>
          <p className="font-sans text-meta text-muted-foreground">{starCount(person.stars)}</p>
        </div>
      </div>
      {person.languages.length > 0 && (
        <LanguageBar languages={person.languages.map(({ language, share }) => ({ name: language, share }))} />
      )}
      <div className="flex flex-col gap-1.5 font-sans text-sm text-muted-foreground">
        {person.topics.length > 0 && (
          <p className="truncate text-secondary-foreground">{`mostly tagged ${person.topics.join(" · ")}`}</p>
        )}
        <p>{`last starred ${starredOn(person.lastStarredAt)}`}</p>
        {person.shared !== null && (
          <p className="font-semibold text-accent-strong">
            {person.shared === 0 ? "you share no stars" : `you share ${starCount(person.shared)}`}
          </p>
        )}
      </div>
    </Tile>
  );
}

// A card's size while the next page loads, so the cards that replace it move nothing.
function CardPlaceholder() {
  return (
    <Tile aria-hidden className={cardBox}>
      <div className="flex items-center gap-3.5">
        <Skeleton className="size-14 shrink-0 rounded-full" />
        <span className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3.5 w-20" />
        </span>
      </div>
      <Skeleton className="h-3" />
      <Skeleton className="h-3.5 w-4/5" />
      <Skeleton className="h-3.5 w-1/2" />
    </Tile>
  );
}

const pageSize = 24;

const sortLabels: ReadonlyArray<readonly [PeopleSort, string]> = [
  ["most-like-you", "most like you"],
  ["recently-active", "recently active"],
];

// A viewer whose stars have synced can put the people most like them first. Anyone else gets the latest star first.
function Sorts({ page }: { page: People }) {
  if (!page.people.some((person) => person.shared !== null)) return null;
  return (
    <nav aria-label="Sort people" className="flex flex-wrap gap-2">
      {sortLabels.map(([sort, label]) => (
        <Chip
          key={sort}
          active={page.sort === sort}
          render={<Link to="/people" search={{ sort }} aria-current={page.sort === sort ? "true" : undefined} />}
        >
          {label}
        </Chip>
      ))}
    </nav>
  );
}

function List({ first }: { first: People }) {
  const { shown, showMore } = usePeoplePages(first);
  const left = first.total - shown.people.length;
  return (
    <>
      <Sorts page={first} />
      <ol aria-label="people" aria-busy={shown.more === "asking" || undefined} className={grid}>
        {shown.people.map((person) => (
          <li key={person.login} className="flex min-w-0 flex-col *:flex-1">
            <PersonCard person={person} />
          </li>
        ))}
        {shown.more === "asking" &&
          Array.from({ length: Math.max(1, Math.min(pageSize, left)) }, (_, index) => (
            <li key={index} className="flex flex-col *:flex-1">
              <CardPlaceholder />
            </li>
          ))}
      </ol>
      {shown.next !== null && shown.more !== "asking" && (
        <div className="flex flex-col items-center gap-2">
          {shown.more === "failed" && (
            <p role="status" className="font-sans text-meta text-muted-foreground">
              couldn't load more people.
            </p>
          )}
          <Button variant="ghost" size="lg" onClick={showMore}>
            {shown.more === "failed" ? "try again" : "show more"}
          </Button>
        </div>
      )}
    </>
  );
}

function Body({ first }: { first: FirstPeople }) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  if (first.kind === "failed")
    return (
      <EmptyTile pose="scared" heading="couldn't load people" body="stargrep couldn't read the people list just now.">
        <Button
          variant="primary"
          size="lg"
          className="mt-2"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            router.invalidate().finally(() => setRetrying(false));
          }}
        >
          try again
        </Button>
      </EmptyTile>
    );
  // The list fills in overnight, so a new stage starts with nobody on it.
  if (first.page.people.length === 0)
    return (
      <EmptyTile
        pose="unsure"
        heading="nobody here yet"
        body="the people list fills in overnight. until then, type any GitHub username above."
      />
    );
  return <List first={first.page} />;
}

// Everyone on the people list, a page at a time, under the same username field as the landing.
export function PeoplePage() {
  const { viewer, repoStars } = useLoaderData({ from: "__root__" });
  const { first } = useLoaderData({ from: "/people" });
  return (
    <Page header={<SiteHeader viewer={viewer} repoStars={repoStars} />}>
      <section className="flex flex-col gap-3.5 pt-1.5 sm:pt-5">
        <h1 className="flex items-baseline gap-3 font-display text-3xl leading-10 font-semibold tracking-tight sm:text-[52px] sm:leading-[56px]">
          people
          {first.kind === "found" && first.page.total > 0 && (
            <span className="font-sans text-base font-normal tracking-normal text-muted-foreground tabular-nums sm:text-lg">
              {formatCount(first.page.total)}
            </span>
          )}
        </h1>
        <div className="lg:max-w-[620px]">
          <LoginField />
        </div>
      </section>
      <Body first={first} />
    </Page>
  );
}
