import {
  Button,
  buttonVariants,
  Chip,
  cn,
  EmptyTile,
  formatStars,
  Pip,
  RepoIcon,
  RepoPanel,
  Skeleton,
  Tile,
} from "@stargrep/ui";
import { Link, useLoaderData, useRouter } from "@tanstack/react-router";
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import { capture } from "../lib/analytics.ts";
import { avatarOf } from "../lib/avatar.ts";
import { checkedAgo, type DayGroup, dayGroup, on, weeksAgo, when, withinWeek } from "../lib/follow-time.ts";
import { follow, useFollows } from "../lib/follows.ts";
import { useGitHubFollowing } from "../lib/github-following.ts";
import { plainDetail } from "../lib/plain-detail.ts";
import { repoVisual } from "../lib/repo-visual.ts";
import { api, type FeedRepo, type FollowingFeed, type Person } from "../lib/rpc.ts";
import { loginPage } from "../lib/stars-route.ts";
import { after, isoAt, wallNow } from "../lib/wall-clock.ts";
import { formatCount, peopleCount, starCount } from "../lib/whose.ts";
import { textLinkClass } from "./external-text-link.tsx";
import { FollowPill } from "./follows.tsx";
import { Page } from "./page.tsx";
import { SignInButton } from "./sign-in-button.tsx";
import { TopicChips } from "./topic-chips.tsx";

export { FollowingPeoplePage, loadFollowedPeople } from "./following-people.tsx";

// What /following shows: a signed-out visitor's explanation, a signed-in viewer's feed, or a feed that failed to load.
// A viewer who follows nobody gets the people most like them, read on the server, for the cold start.
export type FollowingData =
  | { readonly kind: "signed-out"; readonly faces: ReadonlyArray<string>; readonly total: number }
  | {
      readonly kind: "feed";
      readonly feed: FollowingFeed;
      readonly at: number;
      readonly alike: ReadonlyArray<Person>;
    }
  | { readonly kind: "failed" };

// The people most like the viewer, for the cold start and a quiet month. Nobody when the list can't be read.
const alikeOf = () =>
  api()
    .people({ sort: "most-like-you", limit: 12 })
    .then(
      (page) => page.people.filter((person) => person.shared !== null && person.shared > 0),
      () => [],
    );

export const loadFollowing = async (signedIn: boolean): Promise<FollowingData> => {
  if (!signedIn) {
    const page = await api()
      .people({ sort: "recently-active", limit: 6 })
      .catch(() => undefined);
    return {
      kind: "signed-out",
      faces: page?.people.map((person) => person.login) ?? [],
      total: page?.total ?? 0,
    };
  }
  try {
    const [feed, alike] = await Promise.all([api().followingFeed(), alikeOf()]);
    return { kind: "feed", feed, at: wallNow(), alike };
  } catch {
    return { kind: "failed" };
  }
};

const pageHeading = "font-display text-2xl font-semibold tracking-[-0.02em] sm:text-4xl";

// What the feed covers and how fresh it is, and the way to manage the people it follows.
function Heading({ feed, at }: { feed: FollowingFeed | undefined; at: number }) {
  return (
    <section className="flex flex-col gap-1.5 pt-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6 sm:px-1 sm:pt-3">
      <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
        <h1 className={pageHeading}>following</h1>
        {feed !== undefined && (
          <p className="font-sans text-base leading-5 text-muted-foreground">
            {feed.following === 0
              ? "nobody yet"
              : `what your ${peopleCount(feed.following)} starred, last ${feed.windowDays} days`}
          </p>
        )}
      </div>
      {feed !== undefined && feed.following > 0 && (
        <p className="flex items-baseline gap-4 font-sans text-sm text-muted-foreground">
          {feed.checkedAt !== null && `checked ${checkedAgo(feed.checkedAt, at)}`}
          <Link to="/following/people" className={cn(textLinkClass, "text-meta font-semibold")}>
            manage →
          </Link>
        </p>
      )}
    </section>
  );
}

function Faces({ logins, size, ring }: { logins: ReadonlyArray<string>; size: number; ring: string }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {logins.map((login, index) => (
        <img
          key={login}
          src={avatarOf(login, size)}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          className={cn("shrink-0 rounded-full border-2 bg-accent-soft", ring, index > 0 && "-ml-1.5")}
          style={{ width: size, height: size }}
        />
      ))}
    </span>
  );
}

const names = (logins: ReadonlyArray<string>) =>
  logins.length === 2 ? `@${logins[0]} and @${logins[1]}` : `@${logins[0]}`;

// Who starred a repo and when. One or two people are named. Three or more are counted, with the first and the latest.
function Attribution({ repo, at }: { repo: FeedRepo; at: number }) {
  const logins = repo.starredBy.map((starrer) => starrer.login);
  const latest = repo.starredBy[0];
  const first = repo.starredBy.at(-1);
  if (latest === undefined || first === undefined) return null;
  const many = logins.length > 2;
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-sans text-sm font-semibold">
        {many ? `${logins.length} you follow starred this` : names(logins)}
      </span>
      <span className="truncate font-sans text-[13px] leading-4 text-muted-foreground">
        {many
          ? `since ${on(first.starredAt)} · latest ${when(latest.starredAt, at)}`
          : `starred ${when(latest.starredAt, at)}`}
      </span>
    </span>
  );
}

type Open = (repo: FeedRepo, opener: HTMLElement, from: "feed" | "top", position: number) => void;

const plainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

// One repo the people you follow starred: what it is, who starred it and when, and its stars. Fixed lanes for faces,
// attribution and stars, so the eye runs down one column of who and when. A plain click opens the repo panel.
function FeedRow({ repo, at, position, onOpen }: { repo: FeedRepo; at: number; position: number; onOpen: Open }) {
  const faces = repo.starredBy.slice(0, 3).map((starrer) => starrer.login);
  const latest = repo.starredBy[0];
  return (
    <li>
      <a
        href={repo.url}
        onClick={(event) => {
          if (!plainClick(event)) return;
          event.preventDefault();
          onOpen(repo, event.currentTarget, "feed", position);
        }}
        className="flex items-start gap-3.5 squircle rounded-md bg-card px-gap py-4 transition-colors duration-120 hover:bg-card/70 sm:items-center sm:gap-5 sm:px-7 sm:py-5"
      >
        <RepoIcon visual={repoVisual(repo, "card")} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-display text-[20px] leading-6 font-semibold tracking-[-0.01em] sm:text-[22px] sm:leading-7">
              {repo.name}
            </span>
            <span className="truncate font-sans text-sm text-muted-foreground max-sm:hidden">
              {[repo.owner, repo.language].filter((part) => part !== null).join(" · ")}
            </span>
          </span>
          <span className="truncate font-sans text-sm text-muted-foreground sm:hidden">
            {[repo.owner, repo.language, repo.stars === null ? null : `★ ${formatStars(repo.stars)}`]
              .filter((part) => part !== null)
              .join(" · ")}
          </span>
          {repo.description !== null && (
            <span className="line-clamp-1 font-sans text-[15px] leading-[22px] text-secondary-foreground max-sm:hidden">
              {repo.description}
            </span>
          )}
          <span className="flex min-w-0 items-center gap-2 pt-1 sm:hidden">
            <Faces logins={faces} size={24} ring="border-card" />
            <span className="truncate font-sans text-sm font-semibold">
              {repo.starredBy.length > 2
                ? `${repo.starredBy.length} you follow`
                : repo.starredBy.map((starrer) => `@${starrer.login}`).join(", ")}
            </span>
            {latest !== undefined && (
              <span className="shrink-0 font-sans text-sm text-muted-foreground">{when(latest.starredAt, at)}</span>
            )}
          </span>
        </span>
        <span className="flex w-[330px] shrink-0 items-center gap-3 max-sm:hidden">
          <span className="flex w-[92px] shrink-0 justify-end">
            <Faces logins={faces} size={32} ring="border-card" />
          </span>
          <Attribution repo={repo} at={at} />
        </span>
        <span className="flex w-24 shrink-0 items-center justify-end gap-1.5 max-sm:hidden">
          {repo.stars !== null && (
            <>
              <svg viewBox="0 0 24 24" aria-hidden className="size-4">
                <path
                  d="M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.95z"
                  fill="currentColor"
                />
              </svg>
              <span className="font-display text-[22px] leading-7 font-semibold">{formatStars(repo.stars)}</span>
            </>
          )}
        </span>
      </a>
    </li>
  );
}

// The repo the most people you follow starred this week, as the page's butter tile.
function TopTile({ repo, starrers, at, onOpen }: { repo: FeedRepo; starrers: number; at: number; onOpen: Open }) {
  const week = repo.starredBy.filter((starrer) => withinWeek(starrer.starredAt, at));
  const first = repo.starredBy.at(-1);
  const latest = repo.starredBy[0];
  return (
    <Tile variant="highlight" className="flex min-w-0 flex-col gap-4 px-gap pt-6 pb-6 sm:px-7.5 sm:pt-6.5 lg:flex-1">
      <a
        href={repo.url}
        onClick={(event) => {
          if (!plainClick(event)) return;
          event.preventDefault();
          onOpen(repo, event.currentTarget, "top", 1);
        }}
        className="flex flex-col gap-4 rounded-sm after:absolute after:inset-0"
      >
        <span className="flex items-center gap-2.5">
          <span className="max-sm:hidden">
            <Faces logins={week.slice(0, 5).map((starrer) => starrer.login)} size={32} ring="border-highlight" />
          </span>
          <span className="sm:hidden">
            <Faces logins={week.slice(0, 3).map((starrer) => starrer.login)} size={28} ring="border-highlight" />
          </span>
          <span className="font-display text-lg leading-6 font-semibold sm:text-[20px]">
            <span className="max-sm:hidden">{`starred by ${starrers} you follow this week`}</span>
            <span className="sm:hidden">{`${starrers} you follow · this week`}</span>
          </span>
        </span>
        <span className="flex items-start gap-4">
          <RepoIcon visual={repoVisual(repo, "panel")} size="panel" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-display text-[28px] leading-8 font-semibold tracking-[-0.02em] sm:text-[36px] sm:leading-10">
              {repo.name}
            </span>
            <span className="font-sans text-sm text-secondary-foreground">
              {[repo.owner, repo.language].filter((part) => part !== null).join(" · ")}
              {repo.stars !== null && <span className="sm:hidden">{` · ★ ${formatStars(repo.stars)}`}</span>}
            </span>
          </span>
        </span>
        {repo.description !== null && (
          <span className="line-clamp-2 font-sans text-base leading-6 sm:text-[17px] sm:leading-[26px]">
            {repo.description}
          </span>
        )}
      </a>
      <div className="mt-auto flex items-center justify-between gap-4 border-t-[1.5px] border-ink/12 pt-3.5 max-sm:hidden">
        {repo.stars !== null && (
          <span className="flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" aria-hidden className="size-5">
              <path
                d="M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.95z"
                fill="currentColor"
              />
            </svg>
            <span className="font-display text-[30px] leading-[34px] font-semibold">{formatStars(repo.stars)}</span>
          </span>
        )}
        {first !== undefined && latest !== undefined && (
          <span className="truncate font-sans text-sm text-secondary-foreground">
            {`first by @${first.login} on ${on(first.starredAt)} · latest @${latest.login} ${when(latest.starredAt, at)}`}
          </span>
        )}
      </div>
    </Tile>
  );
}

function BusiestTile({ feed, at }: { feed: FollowingFeed; at: number }) {
  return (
    <Tile className="flex min-w-0 flex-col gap-4 pt-6 pr-5.5 pb-5.5 pl-6 max-sm:hidden lg:flex-1">
      <h2 className="font-display text-[30px] leading-[34px] font-semibold tracking-[-0.01em]">busiest this week</h2>
      <ul className="flex flex-col gap-3.5">
        {feed.busiest.map((busy) => (
          <li key={busy.login}>
            <Link {...loginPage(busy.login)} className="flex items-center gap-3 rounded-sm">
              <img
                src={avatarOf(busy.login, 40)}
                alt=""
                width={40}
                height={40}
                loading="lazy"
                className="size-10 shrink-0 rounded-full bg-accent-soft"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-display text-[17px] leading-[22px] font-semibold">{`@${busy.login}`}</span>
                <span className="font-sans text-[13px] leading-4 text-muted-foreground">
                  {`starred ${formatCount(busy.stars)} · latest ${when(busy.latestAt, at)}`}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Link to="/following/people" className={cn(buttonVariants({ variant: "secondary" }), "mt-auto self-start")}>
        {`all ${formatCount(feed.following)} people`}
      </Link>
    </Tile>
  );
}

function Arriving({ count }: { count: number }) {
  return (
    <Tile className="flex flex-col overflow-clip p-0">
      <p role="status" className="flex h-16 items-center gap-2.5 px-gap font-sans text-sm font-semibold sm:px-7">
        <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0 motion-safe:animate-spin">
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--color-accent-soft)" strokeWidth="2.5" />
          <path
            d="M8 2a6 6 0 0 1 6 6"
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
        {`stars arriving from ${count === 1 ? "1 person" : `${formatCount(count)} people`}`}
      </p>
      <div aria-hidden data-slot="navigating" className="relative h-[3px] overflow-hidden bg-muted" />
    </Tile>
  );
}

const groupOrder: ReadonlyArray<DayGroup> = ["today", "yesterday", "this week", "earlier"];
const step = 20;

function RowSkeleton() {
  return (
    <li aria-hidden className="flex items-center gap-5 squircle rounded-md bg-card px-gap py-5 sm:px-7">
      <Skeleton className="size-11 shrink-0 rounded-sm" />
      <span className="flex flex-1 flex-col gap-2.5">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-3 w-full max-w-[420px]" />
      </span>
      <span className="flex w-[330px] items-center gap-3 max-sm:hidden">
        <Skeleton className="ml-auto size-8 rounded-full" />
        <Skeleton className="h-3 w-[150px]" />
      </span>
      <Skeleton className="h-4 w-14 max-sm:hidden" />
    </li>
  );
}

function PeopleSuggestions({
  heading,
  people,
  line,
}: {
  heading: string;
  people: ReadonlyArray<Person>;
  line: (person: Person) => string;
}) {
  return (
    <ul aria-label={heading} className="flex flex-col gap-3.5">
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
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-display text-[17px] leading-[22px] font-semibold">{`@${person.login}`}</span>
              <span className="truncate font-sans text-[13px] leading-4 text-muted-foreground">{line(person)}</span>
            </span>
          </Link>
          <FollowPill login={person.login} signedIn />
        </li>
      ))}
    </ul>
  );
}

function Quiet({ feed, at, alike }: { feed: FollowingFeed; at: number; alike: ReadonlyArray<Person> }) {
  const follows = useFollows(true);
  const busier = alike.filter((person) => !follows.isFollowing(person.login)).slice(0, 3);
  const since = on(isoAt(at - feed.windowDays * 86_400_000));
  const who = feed.following === 1 ? "the person" : `the ${formatCount(feed.following)} people`;
  return (
    <div className="flex flex-col gap-gap lg:flex-row">
      <Tile className="flex min-w-0 flex-col gap-5 pt-tile-top pr-6 pb-6 pl-6 sm:flex-row sm:items-center sm:gap-6 sm:pl-tile-lg lg:flex-1">
        <Pip pose="unsure" size={96} className="shrink-0" />
        <div className="flex flex-col gap-2">
          <h2 className="font-display text-2xl font-semibold tracking-snug">a quiet month</h2>
          <p className="font-sans text-base text-secondary-foreground">
            {`nothing new from ${who} you follow since ${since}.`}
            {feed.lastStar !== null &&
              ` their last star was @${feed.lastStar.login}'s, ${weeksAgo(feed.lastStar.starredAt, at)}.`}
          </p>
        </div>
      </Tile>
      {busier.length > 0 && (
        <Tile className="flex min-w-0 flex-col gap-4 pt-6 pr-5.5 pb-5.5 pl-6 lg:flex-1">
          <h2 className="font-display text-[22px] leading-7 font-semibold">busier people like you</h2>
          <PeopleSuggestions
            heading="busier people like you"
            people={busier}
            line={(person) => `${starCount(person.shared ?? 0)} in common · last starred ${on(person.lastStarredAt)}`}
          />
        </Tile>
      )}
    </div>
  );
}

function Feed({ feed, at, alike }: { feed: FollowingFeed; at: number; alike: ReadonlyArray<Person> }) {
  const [shown, setShown] = useState(step);
  const [open, setOpen] = useState<{ readonly repo: FeedRepo; readonly opener: HTMLElement }>();
  const [panelOpen, setPanelOpen] = useState(false);
  const onOpen: Open = (repo, opener, from, position) => {
    capture("following_repo_opened", { from, position });
    setOpen({ repo, opener });
    setPanelOpen(true);
  };
  const top = feed.top === null ? undefined : feed.repos.find((repo) => repo.id === feed.top?.id);
  const rows = feed.repos.filter((repo) => repo !== top);
  const page = rows.slice(0, shown);
  const groups = Map.groupBy(page, (repo) => dayGroup(repo.starredBy[0]?.starredAt ?? "", at));
  const counts = Map.groupBy(rows, (repo) => dayGroup(repo.starredBy[0]?.starredAt ?? "", at));
  let position = 0;
  return (
    <>
      {feed.arriving > 0 && <Arriving count={feed.arriving} />}
      {top !== undefined && feed.top !== null && (
        <div className="flex flex-col gap-gap lg:flex-row">
          <TopTile repo={top} starrers={feed.top.starrers} at={at} onOpen={onOpen} />
          {feed.busiest.length > 0 && <BusiestTile feed={feed} at={at} />}
        </div>
      )}
      {feed.repos.length === 0 && feed.arriving === 0 && <Quiet feed={feed} at={at} alike={alike} />}
      {groupOrder.map((group) => {
        const members = groups.get(group);
        if (members === undefined) return null;
        const size = counts.get(group)?.length ?? members.length;
        return (
          <section key={group} aria-label={group} className="flex flex-col gap-3.5 pt-3">
            <h2 className="flex items-baseline gap-3 font-display text-[26px] leading-[34px] font-semibold">
              {group}
              <span className="font-sans text-sm font-normal text-muted-foreground max-sm:hidden">
                {size === 1 ? "1 repo" : `${formatCount(size)} repos`}
              </span>
            </h2>
            <ol className="flex flex-col gap-3">
              {members.map((repo) => {
                position += 1;
                return <FeedRow key={repo.id} repo={repo} at={at} position={position} onOpen={onOpen} />;
              })}
            </ol>
          </section>
        );
      })}
      {rows.length > shown && (
        <Button variant="muted" className="self-center" onClick={() => setShown((count) => count + step)}>
          show more
        </Button>
      )}
      <RepoPanel
        repo={open && plainDetail(open.repo, open.repo.stars, at)}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        returnFocus={open?.opener ?? null}
        topics={<TopicChips topics={open?.repo.topics ?? []} />}
      />
    </>
  );
}

// The cold start's butter tile: the people the viewer follows on GitHub who are on stargrep, followed in one click. It
// copies the list once, and changes on GitHub change nothing here.
function ImportTile({ login }: { login: string }) {
  const found = useGitHubFollowing(login);
  const follows = useFollows(true);
  const [done, setDone] = useState<number>();
  if (found.kind === "reading") return <Tile variant="highlight" aria-busy className="h-[300px] max-sm:h-[220px]" />;
  if (found.kind === "refused")
    return (
      <Tile className="flex items-center gap-6 px-gap py-6 sm:px-10">
        <Pip pose="unsure" size={88} className="shrink-0 max-sm:hidden" />
        <div className="flex flex-col gap-1.5">
          <h2 className="font-display text-[26px] leading-8 font-semibold sm:text-[34px] sm:leading-10">
            GitHub needs a breather
          </h2>
          <p className="font-sans text-base text-secondary-foreground">
            {found.limited
              ? "stargrep reads who you follow on GitHub once a day. try again tomorrow, or start with the people below."
              : "stargrep couldn't read who you follow on GitHub just now. try again in a few minutes."}
          </p>
        </div>
      </Tile>
    );
  const people = found.answer.people.filter((person) => !follows.isFollowing(person.login));
  if (done !== undefined)
    return (
      <Tile variant="highlight" className="flex items-center gap-6 px-gap py-6 sm:px-10">
        <span className="flex size-[88px] shrink-0 items-center justify-center rounded-full bg-plate max-sm:hidden sm:size-[132px]">
          <Pip pose="happy" size={72} />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-[30px] leading-9 font-semibold sm:text-[40px] sm:leading-[44px]">
            {`following ${formatCount(done)}`}
          </h2>
          <p className="font-sans text-base text-secondary-foreground">their recent stars show below.</p>
        </div>
      </Tile>
    );
  if (people.length === 0) return null;
  const named = people.slice(0, 3).map((person) => `@${person.login}`);
  const more = people.length - named.length;
  const pending = people.some((person) => follows.isPending(person.login));
  return (
    <Tile variant="highlight" className="flex items-center gap-8 px-gap pt-7 pb-7 sm:px-10 sm:pt-10 sm:pb-10">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <h2 className="font-display text-[28px] leading-8 font-semibold tracking-[-0.01em] sm:text-[44px] sm:leading-[52px]">
          {`${formatCount(people.length)} ${people.length === 1 ? "person" : "people"} you follow on GitHub ${people.length === 1 ? "is" : "are"} here`}
        </h2>
        <p className="flex min-w-0 items-center gap-3 font-sans text-base">
          <Faces logins={people.slice(0, 6).map((person) => person.login)} size={44} ring="border-highlight" />
          <span className="min-w-0 truncate max-sm:hidden">
            {more > 0 ? `${named.join(", ")} and ${formatCount(more)} more` : named.join(", ")}
          </span>
        </p>
        <p className="font-sans text-base text-secondary-foreground">
          {"a one-time copy of who you follow on GitHub. changes there won't change it here."}
          {found.answer.notOnStargrep > 0 && ` ${formatCount(found.answer.notOnStargrep)} more aren't on stargrep yet.`}
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Button
            variant="primary"
            size="lg"
            disabled={pending}
            onClick={() => {
              const logins = people.map((person) => person.login);
              void follow(logins, "github").then((result) => {
                if (result !== undefined) setDone(result.following.length);
              });
            }}
          >
            {`follow all ${formatCount(people.length)}`}
          </Button>
          <Link
            to="/following/people"
            search={{ pick: true }}
            className={cn(buttonVariants({ size: "lg" }), "bg-plate/60 text-ink hover:bg-plate")}
          >
            pick from the list
          </Link>
        </div>
      </div>
      <span className="flex size-[220px] shrink-0 items-center justify-center rounded-full bg-plate max-lg:hidden">
        <Pip pose="happy" size={160} />
      </span>
    </Tile>
  );
}

const starterTopics: ReadonlyArray<string> = ["nextjs", "rust", "llm", "neovim"];

function ColdStart({ login, alike }: { login: string; alike: ReadonlyArray<Person> }) {
  const follows = useFollows(true);
  const router = useRouter();
  const like = alike.slice(0, 6);
  return (
    <>
      <ImportTile login={login} />
      <div className="flex flex-col gap-gap lg:flex-row">
        {like.length > 0 && (
          <Tile className="flex min-w-0 flex-col gap-5 pt-tile-top pr-6 pb-6 pl-6 lg:flex-[2]">
            <h2 className="font-display text-[30px] leading-[34px] font-semibold tracking-[-0.01em]">most like you</h2>
            <div className="grid gap-x-10 gap-y-3.5 sm:grid-cols-2">
              <PeopleSuggestions
                heading="most like you"
                people={like.slice(0, 3)}
                line={(person) => `${starCount(person.shared ?? 0)} in common`}
              />
              <PeopleSuggestions
                heading="more like you"
                people={like.slice(3)}
                line={(person) => `${starCount(person.shared ?? 0)} in common`}
              />
            </div>
          </Tile>
        )}
        <Tile className="flex min-w-0 flex-col gap-5 pt-tile-top pr-6 pb-6 pl-6 lg:flex-1">
          <h2 className="font-display text-[30px] leading-[34px] font-semibold tracking-[-0.01em]">
            start with a topic
          </h2>
          <p className="font-sans text-base text-secondary-foreground">
            each topic page has the 6 people who star it most, with follow all.
          </p>
          <ul className="flex flex-wrap gap-2">
            {starterTopics.map((topic) => (
              <li key={topic}>
                <Chip render={<Link to="/topics/$topic" params={{ topic }} />}>{`${topic} →`}</Chip>
              </li>
            ))}
          </ul>
        </Tile>
      </div>
      {follows.count > 0 && (
        <p className="font-sans text-base text-muted-foreground">
          {`you follow ${follows.count === 1 ? "1 person" : `${formatCount(follows.count)} people`} now. `}
          <button
            type="button"
            className={textLinkClass}
            onClick={() => void router.invalidate({ filter: (match) => match.routeId === "/following/" })}
          >
            see what they starred
          </button>
        </p>
      )}
    </>
  );
}

function SignedOut({ faces, total }: { faces: ReadonlyArray<string>; total: number }) {
  const more = total - faces.length;
  return (
    <Tile variant="highlight" className="flex items-center gap-8 px-gap py-8 sm:px-14 sm:py-14">
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <h1 className="font-display text-[34px] leading-10 font-semibold tracking-[-0.02em] sm:text-[60px] sm:leading-[64px]">
          see what the people you follow star
        </h1>
        <p className="font-sans text-base sm:text-[20px] sm:leading-8">
          follow developers whose taste you trust, and see the repos they starred lately that you haven't, with who and
          when. your follows stay private.
        </p>
        {faces.length > 0 && (
          <p className="flex items-center gap-3 font-sans text-base">
            <Faces logins={faces} size={44} ring="border-highlight" />
            {more > 0 && <span className="max-sm:hidden">{`and ${formatCount(more)} more on stargrep`}</span>}
          </p>
        )}
        <div className="flex flex-wrap gap-3 pt-1">
          <SignInButton variant="primary" size="lg" mark={false} />
          <Link to="/people" className={cn(buttonVariants({ size: "lg" }), "bg-plate/60 text-ink hover:bg-plate")}>
            browse people
          </Link>
        </div>
      </div>
      <span className="flex size-[240px] shrink-0 items-center justify-center rounded-full bg-plate max-lg:hidden">
        <Pip pose="idle" size={180} />
      </span>
    </Tile>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <Page here="following">{children}</Page>;
}

// The stars arriving from people whose first import is still running land on their own, a few seconds apart.
const useLiveFeed = (initial: FollowingFeed, at: number) => {
  const [live, setLive] = useState({ feed: initial, at });
  useEffect(() => setLive({ feed: initial, at }), [initial, at]);
  useEffect(() => {
    if (live.feed.arriving === 0) return;
    return after(10_000, () => {
      api()
        .followingFeed()
        .then(
          (feed) => setLive({ feed, at: wallNow() }),
          () => {},
        );
    });
  }, [live]);
  return live;
};

function SignedIn({ data, login }: { data: Extract<FollowingData, { kind: "feed" }>; login: string }) {
  const { feed, at } = useLiveFeed(data.feed, data.at);
  return (
    <>
      <Heading feed={feed} at={at} />
      {feed.following === 0 ? (
        <ColdStart login={login} alike={data.alike} />
      ) : (
        <Feed feed={feed} at={at} alike={data.alike} />
      )}
    </>
  );
}

export function FollowingPage() {
  const { viewer } = useLoaderData({ from: "__root__" });
  const { data } = useLoaderData({ from: "/following/" });
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  return (
    <Shell>
      {data.kind === "signed-out" && <SignedOut faces={data.faces} total={data.total} />}
      {data.kind === "failed" && (
        <>
          <Heading feed={undefined} at={0} />
          <EmptyTile pose="scared" heading="couldn't load your feed" body="stargrep couldn't read it just now.">
            <Button
              variant="primary"
              size="lg"
              className="mt-2"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                router
                  .invalidate({ filter: (match) => match.routeId === "/following/" })
                  .finally(() => setRetrying(false));
              }}
            >
              try again
            </Button>
          </EmptyTile>
        </>
      )}
      {data.kind === "feed" && viewer !== null && <SignedIn data={data} login={viewer.login} />}
    </Shell>
  );
}

// The feed's shape while it loads, so nothing moves when it lands.
export function FollowingLoading() {
  return (
    <Shell>
      <section className="flex items-end justify-between pt-1.5 sm:pt-5">
        <div className="flex items-baseline gap-3">
          <h1 className={pageHeading}>following</h1>
          <Skeleton className="h-3.5 w-24" />
        </div>
        <Skeleton className="h-3 w-[220px] max-sm:hidden" />
      </section>
      <div className="flex flex-col gap-gap lg:flex-row">
        <Tile variant="highlight" className="h-[300px] opacity-60 lg:flex-1" />
        <Tile className="flex flex-col gap-4 pt-7 max-sm:hidden lg:flex-1">
          <Skeleton className="h-5.5 w-[220px]" />
          <Skeleton className="h-3.5 w-[300px]" />
          <Skeleton className="h-3.5 w-[260px]" />
          <Skeleton className="h-3.5 w-[280px]" />
        </Tile>
      </div>
      <Skeleton className="mt-3 h-6 w-[110px]" />
      <ol className="flex flex-col gap-3">
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </ol>
    </Shell>
  );
}
