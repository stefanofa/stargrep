import { Button, EmptyTile, RepoIcon, Tile } from "@stargrep/ui";
import { Link, useLoaderData, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { api, type TopicCount, type TopicsList, type Viewer } from "../lib/rpc.ts";
import { topicVisual } from "../lib/topic-visual.ts";
import { formatCount, peopleCount } from "../lib/whose.ts";
import { DiscoverHead, discoverBody, fieldBox } from "./discover-head.tsx";
import { Page } from "./page.tsx";

const topicsShown = 200;

// How many ranked topics show at first and with each "show more": two rows on desktop.
const step = 8;

// How many of the viewer's own topics lead the page.
const yoursShown = 6;

// A topic the viewer's stars carry, by the name of its page, and how many of their stars carry it.
export interface YourTopic {
  readonly topic: string;
  readonly stars: number;
}

// What /topics knows when it paints: the most ranked topics, or that the API refused them, and the topics a signed-in
// viewer's stars carry most that have a page.
export type FirstTopics = ({ readonly kind: "found"; readonly list: TopicsList } | { readonly kind: "failed" }) & {
  readonly yours: ReadonlyArray<YourTopic>;
};

// The topics most of a login's stars carry, each under the page its spelling leads to, counted once. The ones without
// a page drop out, and a failure to read them shows none.
const topicsOf = async (login: string): Promise<ReadonlyArray<YourTopic>> => {
  const { topics } = await api().taste({ login });
  if (topics.length === 0) return [];
  const { pages } = await api().topicPages({ topics: topics.map(({ topic }) => topic) });
  const pageOf = new Map(pages.map(({ topic, page }) => [topic, page]));
  const seen = new Set<string>();
  return topics
    .flatMap(({ topic, count }) => {
      const page = pageOf.get(topic);
      if (page === undefined || seen.has(page)) return [];
      seen.add(page);
      return [{ topic: page, stars: count }];
    })
    .slice(0, yoursShown);
};

export const firstTopics = async (viewer: Viewer | null): Promise<FirstTopics> => {
  const [list, yours] = await Promise.all([
    api()
      .listTopics({ limit: topicsShown })
      .then(
        (found) => ({ kind: "found", list: found }) as const,
        () => ({ kind: "failed" }) as const,
      ),
    viewer === null ? [] : topicsOf(viewer.login).catch(() => []),
  ]);
  return { ...list, yours };
};

type Found =
  | { readonly q: string; readonly kind: "found"; readonly topics: ReadonlyArray<TopicCount> }
  | { readonly q: string; readonly kind: "failed" };

// The topics whose names hold the typed text, asked a moment after the typing stops. The last answer stays on screen
// until the next one lands, so the grid doesn't flash on every keystroke. Undefined while nothing is typed.
const useFound = (typed: string) => {
  const [found, setFound] = useState<Found>();
  const [round, setRound] = useState(0);
  const q = typed.trim().toLowerCase();
  useEffect(() => {
    if (q === "") return;
    let current = true;
    // @effect-diagnostics-next-line globalTimers:off - topic pages load no Effect, so the wait uses the platform's timer.
    const timer = setTimeout(() => {
      api()
        .listTopics({ q, limit: 60 })
        .then(
          ({ topics }) => current && setFound({ q, kind: "found", topics }),
          () => current && setFound({ q, kind: "failed" }),
        );
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q, round]);
  if (q === "") return undefined;
  const retry = () => {
    setFound(undefined);
    setRound((count) => count + 1);
  };
  return { found, asking: found?.q !== q, retry };
};

function Finding({ found, asking, retry }: NonNullable<ReturnType<typeof useFound>>) {
  if (found?.kind === "found" && found.topics.length > 0) return <TopicGrid topics={found.topics} busy={asking} />;
  if (found === undefined || asking)
    return (
      <p role="status" className="px-1 font-sans text-meta text-muted-foreground">
        looking…
      </p>
    );
  if (found.kind === "failed")
    return (
      <EmptyTile pose="scared" heading="couldn't look that up" body="stargrep couldn't search the topics just now.">
        <Button variant="primary" size="lg" className="mt-2" onClick={retry}>
          try again
        </Button>
      </EmptyTile>
    );
  return (
    <EmptyTile
      pose="unsure"
      heading="no topic like that"
      body="a topic gets a page once enough developers star its repos."
    />
  );
}

// The most ranked topics didn't load. Trying again runs this page's loader alone, since the root's runs only on the
// server.
function Unloaded() {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  return (
    <EmptyTile pose="scared" heading="couldn't load topics" body="stargrep couldn't read the topics just now.">
      <Button
        variant="primary"
        size="lg"
        className="mt-2"
        disabled={retrying}
        onClick={() => {
          setRetrying(true);
          router.invalidate({ filter: (match) => match.routeId === "/topics/" }).finally(() => setRetrying(false));
        }}
      >
        try again
      </Button>
    </EmptyTile>
  );
}

// One topic and the one number that says how big it is here: the people into it. A row on phones, a tile from 640px.
function TopicTile({ topic }: { topic: TopicCount }) {
  return (
    <Tile className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-4 py-3 sm:gap-3.5 sm:rounded-[24px] sm:px-6 sm:py-[22px]">
      <RepoIcon visual={topicVisual(topic)} size="tile" />
      <span className="flex min-w-0 flex-1 items-center justify-between gap-3 sm:flex-col sm:items-start sm:gap-px">
        <Link
          to="/topics/$topic"
          params={{ topic: topic.topic }}
          className="truncate font-display text-lg leading-[22px] font-semibold outline-none after:absolute after:inset-0 after:squircle after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring sm:text-[20px] sm:leading-6 sm:after:rounded-[24px]"
        >
          {topic.topic}
        </Link>
        {topic.devs > 0 && (
          <span className="shrink-0 font-sans text-sm text-muted-foreground tabular-nums">
            {peopleCount(topic.devs)}
          </span>
        )}
      </span>
    </Tile>
  );
}

function TopicGrid({ topics, busy = false }: { topics: ReadonlyArray<TopicCount>; busy?: boolean }) {
  return (
    <ol
      aria-label="topics"
      aria-busy={busy || undefined}
      className="grid gap-2 sm:grid-cols-2 sm:gap-gap lg:grid-cols-4"
    >
      {topics.map((topic) => (
        <li key={topic.topic} className="flex min-w-0">
          <TopicTile topic={topic} />
        </li>
      ))}
    </ol>
  );
}

const sectionHeading = "px-1 font-display text-[19px] leading-[22px] font-semibold sm:text-xl sm:leading-7";

// The topics the viewer's own stars carry most, so the page starts from them. Each opens its page.
function Yours({ yours, listed }: { yours: ReadonlyArray<YourTopic>; listed: ReadonlyArray<TopicCount> }) {
  const iconOf = new Map(listed.map(({ topic, icon }) => [topic, icon]));
  return (
    <Tile className="flex flex-col gap-2.5 rounded-[24px] px-[18px] py-4 sm:flex-row sm:items-center sm:gap-3.5 sm:rounded-tile sm:px-6 sm:py-5">
      <h2 className="shrink-0 font-display text-[19px] leading-[22px] font-semibold sm:pr-1.5 sm:text-title sm:leading-[26px]">
        in your stars
      </h2>
      <ul className="flex flex-wrap gap-[7px] sm:gap-2">
        {yours.map(({ topic, stars }) => (
          <li key={topic}>
            <Link
              to="/topics/$topic"
              params={{ topic }}
              className="flex items-center gap-[7px] rounded-full bg-accent-soft px-[11px] py-[5px] font-sans text-meta font-medium transition-colors duration-120 hover:bg-accent/30 sm:py-1 sm:pr-3 sm:pl-1"
            >
              <span className="max-sm:hidden">
                <RepoIcon visual={topicVisual({ topic, icon: iconOf.get(topic) ?? null })} size="chip" />
              </span>
              <span>
                {topic} <span className="font-normal text-muted-foreground tabular-nums">{formatCount(stars)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

// The most ranked topics, a few rows at a time.
function MostRanked({ topics }: { topics: ReadonlyArray<TopicCount> }) {
  const [shown, setShown] = useState(step);
  return (
    <>
      <h2 className={`${sectionHeading} pt-1 sm:pt-1.5`}>most ranked</h2>
      <TopicGrid topics={topics.slice(0, shown)} />
      {topics.length > shown && (
        <Button variant="secondary" className="self-center px-[18px]" onClick={() => setShown((count) => count + step)}>
          show more
        </Button>
      )}
    </>
  );
}

function FindField({ typed, onType }: { typed: string; onType: (typed: string) => void }) {
  const field = useId();
  return (
    <search>
      <form onSubmit={(event) => event.preventDefault()} className={fieldBox}>
        <label htmlFor={field} className="sr-only">
          find a topic
        </label>
        <input
          id={field}
          type="search"
          value={typed}
          onChange={(event) => onType(event.target.value)}
          placeholder="find a topic, such as nextjs or rust"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={50}
          className="h-full min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        />
      </form>
    </search>
  );
}

// Discover's topics: the ones the viewer's stars carry most, then every topic with a page, the most ranked first, and a
// field that finds one by its name.
export function TopicsPage() {
  const { first } = useLoaderData({ from: "/topics/" });
  const [typed, setTyped] = useState("");
  const finding = useFound(typed);
  const listed = first.kind === "found" ? first.list.topics : [];
  return (
    <Page here="discover">
      <div className={discoverBody}>
        <DiscoverHead segment="topics">
          <FindField typed={typed} onType={setTyped} />
        </DiscoverHead>
        {finding !== undefined ? (
          <Finding {...finding} />
        ) : (
          <>
            {first.yours.length > 0 && <Yours yours={first.yours} listed={listed} />}
            {first.kind === "failed" ? (
              <Unloaded />
            ) : listed.length === 0 ? (
              <EmptyTile pose="unsure" heading="no topics yet" body="topic pages fill in overnight." />
            ) : (
              <MostRanked topics={listed} />
            )}
          </>
        )}
      </div>
    </Page>
  );
}
