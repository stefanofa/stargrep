import {
  Button,
  buttonVariants,
  Chip,
  EmptyTile,
  formatStars,
  type RepoDetail,
  RepoIcon,
  RepoPanel,
  Skeleton,
  Tile,
} from "@stargrep/ui";
import { Link, useLoaderData, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, type MouseEvent, useEffect, useId, useState } from "react";
import { avatarOf } from "../lib/avatar.ts";
import { plainDetail } from "../lib/plain-detail.ts";
import { repoVisual } from "../lib/repo-visual.ts";
import { api, type SearchResult, type Topic, type TopicRepo, wireCode } from "../lib/rpc.ts";
import { loginPage } from "../lib/stars-route.ts";
import { topicExamples } from "../lib/topic-examples.ts";
import { topicSearch, topicSearchLimit } from "../lib/topic-search.ts";
import { topicVisual } from "../lib/topic-visual.ts";
import { formatCount, starCount } from "../lib/whose.ts";
import { textLinkClass } from "./external-text-link.tsx";
import { FollowAll } from "./follows.tsx";
import { Page } from "./page.tsx";
import { SiteHeader } from "./site-header.tsx";
import { TopicChips } from "./topic-chips.tsx";

// What the route finds for a typed topic: its page, the topic another spelling leads to, or nothing.
export type FoundTopic =
  | { readonly kind: "found"; readonly topic: Topic }
  | { readonly kind: "elsewhere"; readonly topic: string }
  | { readonly kind: "missing" };

export const loadTopic = (typed: string): Promise<FoundTopic> =>
  api()
    .topic({ topic: typed })
    .then(
      (topic): FoundTopic =>
        topic.topic === typed ? { kind: "found", topic } : { kind: "elsewhere", topic: topic.topic },
      (error: unknown): FoundTopic => {
        if (wireCode(error) === "TOPIC_NOT_FOUND" || wireCode(error) === "BAD_REQUEST") return { kind: "missing" };
        throw error;
      },
    );

type Shown = TopicRepo | SearchResult;

const plainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

const line = (repo: Shown) => repo.summary ?? repo.description ?? "";

// The repo panel for a repo on this page.
const detail = (repo: Shown, at: number): RepoDetail => plainDetail(repo, "devs" in repo ? repo.stars : null, at);

const sectionHeading = "font-display text-[22px] leading-7 font-semibold tracking-snug";

// One repo in a list: its place, icon, name, owner and one line about it, then how many developers and GitHub users star
// it. A plain click opens the repo panel, and any other click opens it on GitHub.
function RepoRow({
  repo,
  place,
  onOpen,
}: {
  repo: Shown;
  place?: number;
  onOpen: (repo: Shown, opener: HTMLElement) => void;
}) {
  const ranked = "devs" in repo;
  return (
    <li>
      <a
        href={repo.url}
        onClick={(event) => {
          if (!plainClick(event)) return;
          event.preventDefault();
          onOpen(repo, event.currentTarget);
        }}
        className="flex min-w-0 items-center gap-3 squircle rounded-md px-3 py-2.5 transition-colors duration-120 hover:bg-background"
      >
        {place !== undefined && (
          <span className="w-6 shrink-0 text-right font-display text-meta font-semibold text-muted-foreground tabular-nums">
            {place}
          </span>
        )}
        <RepoIcon visual={repoVisual(repo, "row")} size="row" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-display text-[17px] leading-[22px] font-semibold tracking-snug">
            {repo.name}
            <span className="font-sans text-sm font-medium text-muted-foreground">{` ${repo.owner}`}</span>
          </span>
          {line(repo) !== "" && <span className="truncate font-sans text-sm text-muted-foreground">{line(repo)}</span>}
        </span>
        {ranked && (
          <span className="shrink-0 text-right font-sans text-sm text-muted-foreground tabular-nums">
            <span className="font-semibold text-foreground">{`${formatCount(repo.devs)} devs`}</span>
            {repo.stars !== null && <span className="max-sm:hidden">{` · ${formatStars(repo.stars)} ★`}</span>}
          </span>
        )}
      </a>
    </li>
  );
}

function RepoList({
  heading,
  repos,
  ranked,
  onOpen,
  more,
}: {
  heading: string;
  repos: ReadonlyArray<Shown>;
  ranked: boolean;
  onOpen: (repo: Shown, opener: HTMLElement) => void;
  more?: { readonly shown: number; readonly show: () => void };
}) {
  const shown = more === undefined ? repos : repos.slice(0, more.shown);
  return (
    <Tile className="flex min-w-0 flex-col gap-2 pt-6 pr-tile-sm pb-tile-sm pl-6 max-sm:px-3">
      <h2 className={`${sectionHeading} max-sm:px-3`}>{heading}</h2>
      <ol className="-mx-3 flex flex-col max-sm:mx-0">
        {shown.map((repo, index) => (
          <RepoRow key={repo.id} repo={repo} {...(ranked ? { place: index + 1 } : {})} onOpen={onOpen} />
        ))}
      </ol>
      {more !== undefined && repos.length > more.shown && (
        <Button variant="secondary" size="default" className="self-start max-sm:ml-3" onClick={more.show}>
          show more
        </Button>
      )}
    </Tile>
  );
}

type Asked =
  | { readonly state: "idle" }
  | { readonly state: "asking"; readonly q: string }
  | { readonly state: "found"; readonly q: string; readonly results: ReadonlyArray<SearchResult> }
  | { readonly state: "failed"; readonly q: string; readonly limited: boolean };

// The topic's search: the query lives in ?q=, so a search is a link to share, and each one asks the server once.
const useTopicSearch = (topic: string, q: string | undefined) => {
  const [asked, setAsked] = useState<Asked>({ state: "idle" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (q === undefined || q.trim() === "") {
      setAsked({ state: "idle" });
      return;
    }
    let current = true;
    setAsked({ state: "asking", q });
    api()
      .search(topicSearch(topic, q))
      .then(
        ({ results }) => current && setAsked({ state: "found", q, results }),
        (error: unknown) =>
          current && setAsked({ state: "failed", q, limited: wireCode(error) === "TOO_MANY_REQUESTS" }),
      );
    return () => {
      current = false;
    };
  }, [topic, q, round]);
  return { asked, retry: () => setRound((count) => count + 1) };
};

function SearchField({ topic, q }: { topic: string; q: string | undefined }) {
  const navigate = useNavigate();
  const field = useId();
  const search = (query: string) =>
    navigate({ to: "/topics/$topic", params: { topic }, search: query === "" ? {} : { q: query }, replace: true });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    search(String(new FormData(event.currentTarget).get("q") ?? "").trim());
  };
  const examples = topicExamples[topic] ?? [];
  return (
    <div className="flex flex-col gap-3 lg:max-w-[620px]">
      <search>
        <form
          onSubmit={submit}
          className="flex h-12 items-center rounded-full bg-card pr-1 pl-5 font-sans text-lg focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring sm:h-14 sm:pr-1.5"
        >
          <label htmlFor={field} className="sr-only">
            {`search ${topic} repos`}
          </label>
          <input
            key={q ?? ""}
            id={field}
            name="q"
            type="search"
            defaultValue={q ?? ""}
            placeholder={`search ${topic} repos`}
            autoComplete="off"
            enterKeyHint="search"
            maxLength={500}
            className="h-full min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
          <Button type="submit" size="lg" className="h-10 px-5 sm:h-11">
            search
          </Button>
        </form>
      </search>
      {examples.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {examples.map((example) => (
            <Chip key={example} active={q === example} onClick={() => search(example)}>
              {example}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

const placeholders = 4;

// The answer's tile while the search runs, with rows the size of the ones that replace them.
function Searching() {
  return (
    <Tile aria-busy className="flex min-w-0 flex-col gap-2 pt-6 pr-tile-sm pb-tile-sm pl-6 max-sm:px-3">
      <p role="status" className={`${sectionHeading} max-sm:px-3`}>
        searching…
      </p>
      <ul aria-hidden className="-mx-3 flex flex-col max-sm:mx-0">
        {Array.from({ length: placeholders }, (_, index) => (
          <li key={index} className="flex items-center gap-3 px-3 py-2.5">
            <Skeleton className="size-9 shrink-0 squircle rounded-sm" />
            <span className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3.5 w-4/5" />
            </span>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

// The stars page's words for a search that didn't answer, and for a network that asked too often.
const missed = {
  failed: {
    pose: "scared",
    heading: "stargrep couldn't search that",
    body: "the search didn't answer. try again in a moment.",
  },
  limited: { pose: "unsure", heading: "lots of searches from your network", body: "give it a minute, then try again." },
} as const;

function Answer({
  topic,
  asked,
  onOpen,
  retry,
}: {
  topic: string;
  asked: Exclude<Asked, { state: "idle" }>;
  onOpen: (repo: Shown, opener: HTMLElement) => void;
  retry: () => void;
}) {
  if (asked.state === "asking") return <Searching />;
  if (asked.state === "failed")
    return (
      <EmptyTile {...missed[asked.limited ? "limited" : "failed"]}>
        <Button variant="primary" size="lg" className="mt-2" onClick={retry}>
          try again
        </Button>
      </EmptyTile>
    );
  if (asked.results.length === 0)
    return (
      <EmptyTile
        pose="sad"
        heading="nothing matches that"
        body={`no ${topic} repo matches "${asked.q}". try other words.`}
      />
    );
  return (
    <RepoList
      heading={`found ${asked.results.length}${asked.results.length === topicSearchLimit ? "+" : ""}`}
      repos={asked.results}
      ranked={false}
      onOpen={onOpen}
    />
  );
}

function People({ topic, signedIn }: { topic: Topic; signedIn: boolean }) {
  if (topic.people.length === 0) return null;
  return (
    <Tile className="flex min-w-0 flex-col gap-4 pt-6 pr-tile-sm pb-tile-sm pl-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className={sectionHeading}>people who starred these</h2>
        <FollowAll logins={topic.people.map((person) => person.login)} signedIn={signedIn} />
      </div>
      <ul className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        {topic.people.map((person) => (
          <li key={person.login} className="min-w-0">
            <Link {...loginPage(person.login)} className="flex min-w-0 items-center gap-3 rounded-full pr-1">
              <img
                src={avatarOf(person.login, 40)}
                alt=""
                width={40}
                height={40}
                loading="lazy"
                className="size-10 shrink-0 rounded-full bg-accent-soft outline-1 -outline-offset-1 outline-image-edge"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-display text-[17px] leading-[22px] font-semibold">{`@${person.login}`}</span>
                <span className="truncate font-sans text-sm text-muted-foreground">
                  {`${formatCount(person.repos)} of their ${starCount(person.stars)}`}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

const chipPlates = { none: "bg-card", light: "bg-[#ffffff]", dark: "bg-ink" } as const;

// A related topic's logo, as a round face at the start of its chip.
function ChipLogo({ icon }: { icon: NonNullable<Topic["icon"]> }) {
  return (
    <img
      src={icon.url}
      alt=""
      width={24}
      height={24}
      loading="lazy"
      decoding="async"
      className={`size-6 shrink-0 rounded-full object-cover outline-1 -outline-offset-1 outline-image-edge ${chipPlates[icon.plate]}`}
    />
  );
}

function Related({ topic }: { topic: Topic }) {
  return (
    <nav aria-label="related topics" className="flex flex-col gap-3">
      <h2 className={sectionHeading}>related</h2>
      <ul className="flex flex-wrap gap-2">
        {topic.related.map((related) => (
          <li key={related.topic}>
            <Chip
              render={<Link to="/topics/$topic" params={{ topic: related.topic }} />}
              className={related.icon === null ? undefined : "gap-2 pl-1.5"}
            >
              {related.icon !== null && <ChipLogo icon={related.icon} />}
              {related.topic}
            </Chip>
          </li>
        ))}
        <li>
          <Chip tone="card" render={<Link to="/topics" />}>
            all topics
          </Chip>
        </li>
      </ul>
    </nav>
  );
}

const coreStep = 12;
const builtStep = 6;

// A GitHub topic's page: the repos synced developers star most for or about it, the apps built with it, the people who
// star them, and topics nearby, with a search over all of its repos.
export function TopicPage() {
  const { viewer, repoStars } = useLoaderData({ from: "__root__" });
  const { topic } = useLoaderData({ from: "/topics/$topic" });
  const { q } = useSearch({ from: "/topics/$topic" });
  const { asked, retry } = useTopicSearch(topic.topic, q);
  const [coreShown, setCoreShown] = useState(coreStep);
  const [builtShown, setBuiltShown] = useState(builtStep);
  const [open, setOpen] = useState<{ readonly repo: Shown; readonly opener: HTMLElement } | undefined>();
  const [panelOpen, setPanelOpen] = useState(false);
  const onOpen = (repo: Shown, opener: HTMLElement) => {
    setOpen({ repo, opener });
    setPanelOpen(true);
  };
  const { home } = topic;
  return (
    <Page header={<SiteHeader viewer={viewer} repoStars={repoStars} />}>
      <section className="flex flex-col gap-3.5 pt-1.5 sm:pt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <div className="flex min-w-0 items-baseline gap-3 sm:gap-4">
            {topic.icon !== null && (
              <span className="self-center">
                <RepoIcon visual={topicVisual(topic)} size="heading" />
              </span>
            )}
            <h1 className="min-w-0 font-display text-3xl leading-10 font-semibold tracking-tight break-all sm:text-[52px] sm:leading-[56px]">
              {topic.topic}
            </h1>
          </div>
          {home !== null && (
            <a
              href={home.url}
              onClick={(event) => {
                if (!plainClick(event)) return;
                event.preventDefault();
                onOpen(home, event.currentTarget);
              }}
              className={`${textLinkClass} font-sans text-meta font-semibold`}
            >
              {`${home.owner}/${home.name} →`}
            </a>
          )}
        </div>
        <p className="font-sans text-meta text-muted-foreground tabular-nums">
          {`${formatCount(topic.repos)} repos · ${formatCount(topic.ranked)} ranked by developers`}
        </p>
        <SearchField topic={topic.topic} q={q} />
      </section>
      {asked.state !== "idle" && <Answer topic={topic.topic} asked={asked} onOpen={onOpen} retry={retry} />}
      <div className="grid items-start gap-gap lg:grid-cols-2">
        <RepoList
          heading="most starred by developers"
          repos={topic.core}
          ranked
          onOpen={onOpen}
          more={{ shown: coreShown, show: () => setCoreShown((shown) => shown + coreStep * 3) }}
        />
        {topic.built.length > 0 && (
          <RepoList
            heading={`built with ${topic.topic}`}
            repos={topic.built}
            ranked
            onOpen={onOpen}
            more={{ shown: builtShown, show: () => setBuiltShown((shown) => shown + builtStep) }}
          />
        )}
      </div>
      <People topic={topic} signedIn={viewer !== null} />
      <Related topic={topic} />
      <p className="font-sans text-sm text-muted-foreground">
        devs are the developers whose stars stargrep has synced. a star is a bookmark, not a review.
      </p>
      <RepoPanel
        // @effect-diagnostics-next-line globalDate:off - topic pages load no Effect, so the panel reads the platform's clock.
        repo={open && detail(open.repo, Date.now())}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        returnFocus={open?.opener ?? null}
        topics={<TopicChips topics={open?.repo.topics ?? []} />}
      />
    </Page>
  );
}

// A topic without a page: say so, and lead to the topics that have one.
export function TopicMissing() {
  const { viewer, repoStars } = useLoaderData({ from: "__root__" });
  return (
    <Page header={<SiteHeader viewer={viewer} repoStars={repoStars} />}>
      <EmptyTile
        pose="unsure"
        heading="no page for this topic yet"
        body="a topic gets a page once enough developers star its repos."
      >
        <Link to="/topics" className={buttonVariants({ variant: "primary", size: "lg", className: "mt-2" })}>
          see all topics
        </Link>
      </EmptyTile>
    </Page>
  );
}
