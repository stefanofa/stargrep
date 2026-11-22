import { Button, buttonVariants, Chip, cn, EmptyTile, Pip, Skeleton, Tile } from "@stargrep/ui";
import { Link, useLoaderData, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { avatarOf } from "../lib/avatar.ts";
import { checkedAgo, when } from "../lib/follow-time.ts";
import { follow, unfollow, useFollows } from "../lib/follows.ts";
import { useGitHubFollowing } from "../lib/github-following.ts";
import { api, type FollowedPerson } from "../lib/rpc.ts";
import { loginPage } from "../lib/stars-route.ts";
import { after, wallNow } from "../lib/wall-clock.ts";
import { formatCount } from "../lib/whose.ts";
import { FollowPill } from "./follows.tsx";
import { Page } from "./page.tsx";
import { SiteHeader } from "./site-header.tsx";

export type FollowedPeople =
  | { readonly kind: "found"; readonly people: ReadonlyArray<FollowedPerson>; readonly at: number }
  | { readonly kind: "failed" };

export const loadFollowedPeople = (): Promise<FollowedPeople> =>
  api()
    .followedPeople()
    .then(
      ({ people }): FollowedPeople => ({ kind: "found", people, at: wallNow() }),
      (): FollowedPeople => ({ kind: "failed" }),
    );

export type PeopleOrder = "recent" | "name" | "quiet";

const orders: ReadonlyArray<readonly [PeopleOrder, string]> = [
  ["recent", "recently starred"],
  ["name", "a to z"],
  ["quiet", "quiet lately"],
];

const starredAt = (person: FollowedPerson) => (person.lastStarredAt === null ? 0 : Date.parse(person.lastStarredAt));

const sorted = (people: ReadonlyArray<FollowedPerson>, order: PeopleOrder) =>
  people.toSorted((a, b) => {
    if (order === "name") return a.login.localeCompare(b.login);
    if (order === "quiet") return starredAt(a) - starredAt(b);
    return starredAt(b) - starredAt(a);
  });

const undoFor = 5_000;

function Lock() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0">
      <rect x="3" y="7" width="10" height="7" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

const pillBox = "w-[208px] max-sm:w-[112px]";

// One person you follow. The pill unfollows at once, and the row offers undo for 5 seconds before it leaves.
function Row({
  person,
  at,
  unfollowed,
  onUnfollow,
  onUndo,
}: {
  person: FollowedPerson;
  at: number;
  unfollowed: boolean;
  onUnfollow: () => void;
  onUndo: () => void;
}) {
  const line = unfollowed
    ? "unfollowed. their stars leave your feed."
    : person.checkedAt === null
      ? null
      : [
          person.lastStarredAt === null ? "no stars yet" : `last starred ${when(person.lastStarredAt, at)}`,
          `checked ${checkedAgo(person.checkedAt, at)}`,
        ].join(" · ");
  return (
    <li className="flex items-center gap-4 border-b-[1.5px] border-muted py-5 last:border-b-0 sm:py-6">
      <Link {...loginPage(person.login)} className="flex min-w-0 flex-1 items-center gap-4 rounded-sm">
        <img
          src={avatarOf(person.login, 44)}
          alt=""
          width={44}
          height={44}
          loading="lazy"
          className={cn("size-11 shrink-0 rounded-full bg-accent-soft", unfollowed && "opacity-50 grayscale")}
        />
        <span className="flex min-w-0 flex-col">
          <span
            className={cn(
              "truncate font-display text-[22px] leading-7 font-semibold",
              unfollowed && "text-muted-foreground",
            )}
          >{`@${person.login}`}</span>
          <span className="truncate font-sans text-sm text-muted-foreground sm:text-base">
            {line ?? (
              <>
                <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full bg-warning" />
                {`stars arriving · followed ${when(person.followedAt, at)}`}
              </>
            )}
          </span>
        </span>
      </Link>
      {unfollowed ? (
        <Button variant="primary" className={pillBox} onClick={onUndo}>
          undo
        </Button>
      ) : (
        <button
          type="button"
          aria-label={`unfollow @${person.login}`}
          onClick={onUnfollow}
          className={cn(
            buttonVariants({ variant: "muted" }),
            pillBox,
            "group border-[1.5px] border-transparent hover:border-foreground hover:bg-card focus-visible:border-foreground focus-visible:bg-card",
          )}
        >
          <span className="flex items-center gap-2 group-hover:hidden group-focus-visible:hidden">
            <Check />
            following
          </span>
          <span className="hidden group-hover:inline group-focus-visible:inline">unfollow</span>
        </button>
      )}
    </li>
  );
}

// The users the viewer follows on GitHub who are on stargrep, to follow one by one or all at once.
function FromGitHub({ login }: { login: string }) {
  const found = useGitHubFollowing(login);
  const follows = useFollows(true);
  if (found.kind === "reading")
    return (
      <Tile className="flex flex-col gap-4 pt-6 pb-6">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-80" />
      </Tile>
    );
  if (found.kind === "refused")
    return (
      <Tile className="flex items-center gap-5 py-6">
        <Pip pose="unsure" size={56} className="shrink-0" />
        <p className="font-sans text-base text-secondary-foreground">
          {found.limited
            ? "GitHub needs a breather. stargrep reads who you follow there once a day, so try again tomorrow."
            : "GitHub needs a breather. stargrep couldn't read who you follow there just now. try again in a few minutes."}
        </p>
      </Tile>
    );
  const people = found.answer.people;
  const others = people.filter((person) => !follows.isFollowing(person.login));
  return (
    <Tile className="flex flex-col gap-5 pt-6 pr-6 pb-6 pl-6 sm:pl-tile-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-[26px] leading-8 font-semibold">from GitHub</h2>
          <p className="font-sans text-sm text-muted-foreground">
            {people.length === 0
              ? "nobody you follow on GitHub is on stargrep yet."
              : `${formatCount(people.length)} you follow on GitHub ${people.length === 1 ? "is" : "are"} here.`}
            {found.answer.notOnStargrep > 0 &&
              ` ${formatCount(found.answer.notOnStargrep)} more aren't on stargrep yet.`}
          </p>
        </div>
        {others.length > 0 && (
          <Button
            variant="primary"
            disabled={others.some((person) => follows.isPending(person.login))}
            onClick={() =>
              void follow(
                others.map((person) => person.login),
                "github",
              )
            }
          >
            {`follow all ${formatCount(others.length)}`}
          </Button>
        )}
      </div>
      {people.length > 0 && (
        <ul className="grid gap-x-8 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {people.map((person) => (
            <li key={person.login} className="flex min-w-0 items-center gap-3">
              <Link {...loginPage(person.login)} className="flex min-w-0 flex-1 items-center gap-3 rounded-sm">
                <img
                  src={avatarOf(person.login, 40)}
                  alt=""
                  width={40}
                  height={40}
                  loading="lazy"
                  className="size-10 shrink-0 rounded-full bg-accent-soft"
                />
                <span className="truncate font-display text-[17px] leading-[22px] font-semibold">{`@${person.login}`}</span>
              </Link>
              <FollowPill login={person.login} signedIn />
            </li>
          ))}
        </ul>
      )}
    </Tile>
  );
}

function Heading({ count, children }: { count: number | undefined; children?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 pt-1.5 sm:pt-5">
      <h1 className="flex items-baseline gap-3 font-display text-3xl leading-10 font-semibold tracking-tight sm:text-[52px] sm:leading-[56px] sm:tracking-[-0.02em]">
        people you follow
        {count !== undefined && (
          <span className="font-sans text-base font-normal tracking-normal text-muted-foreground tabular-nums sm:text-lg">
            {formatCount(count)}
          </span>
        )}
      </h1>
      {children}
    </section>
  );
}

function List({ people, at, login }: { people: ReadonlyArray<FollowedPerson>; at: number; login: string }) {
  const { pick } = useSearch({ from: "/following/people" });
  const navigate = useNavigate();
  const follows = useFollows(true);
  const [order, setOrder] = useState<PeopleOrder>("recent");
  const [shown, setShown] = useState(people);
  // Each row unfollowed in the last 5 seconds, with how to cancel its leaving.
  const [leaving, setLeaving] = useState<ReadonlyMap<string, () => void>>(new Map());
  const timers = useRef(leaving);
  timers.current = leaving;
  useEffect(() => setShown(people), [people]);
  useEffect(
    () => () => {
      for (const cancel of timers.current.values()) cancel();
    },
    [],
  );
  const settle = (login: string) =>
    setLeaving((current) => {
      const next = new Map(current);
      next.delete(login);
      return next;
    });
  const unfollowOne = (person: FollowedPerson) => {
    void unfollow(person.login);
    const cancel = after(undoFor, () => {
      setShown((current) => current.filter((other) => other.login !== person.login));
      settle(person.login);
    });
    setLeaving((current) => new Map(current).set(person.login, cancel));
  };
  const undo = (person: FollowedPerson) => {
    leaving.get(person.login)?.();
    settle(person.login);
    void follow([person.login], person.source);
  };
  const count = follows.ready ? follows.count : shown.length;
  return (
    <>
      <Heading count={count}>
        <p className="flex items-center gap-2 font-sans text-sm text-muted-foreground sm:text-base">
          <Lock />
          only you see this list. nobody is told when you follow or unfollow.
        </p>
      </Heading>
      {pick === true && <FromGitHub login={login} />}
      {shown.length === 0 ? (
        <Empty onImport={() => void navigate({ to: "/following/people", search: { pick: true } })} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <nav aria-label="Order people" className="flex flex-wrap gap-2">
              {orders.map(([value, label]) => (
                <Chip
                  key={value}
                  active={order === value}
                  aria-pressed={order === value}
                  onClick={() => setOrder(value)}
                >
                  {label}
                </Chip>
              ))}
            </nav>
            {pick !== true && (
              <Link to="/following/people" search={{ pick: true }} className={buttonVariants({ variant: "ghost" })}>
                import from GitHub again
              </Link>
            )}
          </div>
          <Tile className="px-6 py-1 sm:px-10 sm:py-2">
            <ul aria-label="people you follow">
              {sorted(shown, order).map((person) => (
                <Row
                  key={person.login}
                  person={person}
                  at={at}
                  unfollowed={leaving.has(person.login)}
                  onUnfollow={() => unfollowOne(person)}
                  onUndo={() => undo(person)}
                />
              ))}
            </ul>
          </Tile>
        </>
      )}
    </>
  );
}

function Empty({ onImport }: { onImport: () => void }) {
  return (
    <Tile className="flex items-center gap-8 px-gap py-8 sm:px-12">
      <Pip pose="unsure" size={120} className="shrink-0 max-sm:hidden" />
      <div className="flex flex-col gap-4">
        <h2 className="font-display text-[28px] leading-8 font-semibold sm:text-[40px] sm:leading-[44px]">
          you don't follow anyone yet
        </h2>
        <div className="flex flex-wrap gap-3">
          <Link to="/people" className={buttonVariants({ variant: "primary", size: "lg" })}>
            find people to follow
          </Link>
          <Button variant="secondary" size="lg" onClick={onImport}>
            import from GitHub
          </Button>
        </div>
      </div>
    </Tile>
  );
}

export function FollowingPeoplePage() {
  const { viewer, repoStars } = useLoaderData({ from: "__root__" });
  const { people } = useLoaderData({ from: "/following/people" });
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  return (
    <Page header={<SiteHeader viewer={viewer} repoStars={repoStars} />}>
      {people.kind === "failed" || viewer === null ? (
        <>
          <Heading count={undefined} />
          <EmptyTile pose="scared" heading="couldn't load the people you follow" body="try again in a moment.">
            <Button
              variant="primary"
              size="lg"
              className="mt-2"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                router
                  .invalidate({ filter: (match) => match.routeId === "/following/people" })
                  .finally(() => setRetrying(false));
              }}
            >
              try again
            </Button>
          </EmptyTile>
        </>
      ) : (
        <List people={people.people} at={people.at} login={viewer.login} />
      )}
    </Page>
  );
}
