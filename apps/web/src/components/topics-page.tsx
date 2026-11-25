import { Button, EmptyTile, RepoIcon, Tile } from "@stargrep/ui";
import { Link, useLoaderData, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { api, type TopicCount, type TopicsList } from "../lib/rpc.ts";
import { topicVisual } from "../lib/topic-visual.ts";
import { formatCount } from "../lib/whose.ts";
import { Page } from "./page.tsx";

export const topicsShown = 200;

// What /topics knows when it paints: the most ranked topics, or that the API refused them.
export type FirstTopics = { readonly kind: "found"; readonly list: TopicsList } | { readonly kind: "failed" };

export const firstTopics = (): Promise<FirstTopics> =>
  api()
    .listTopics({ limit: topicsShown })
    .then(
      (list): FirstTopics => ({ kind: "found", list }),
      (): FirstTopics => ({ kind: "failed" }),
    );

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
      <p role="status" className="font-sans text-meta text-muted-foreground">
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

function TopicGrid({ topics, busy = false }: { topics: ReadonlyArray<TopicCount>; busy?: boolean }) {
  return (
    <ol aria-busy={busy || undefined} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {topics.map((topic) => (
        <li key={topic.topic} className="flex min-w-0">
          <Tile className="relative flex min-w-0 flex-1 items-center gap-3 py-4 pr-5 pl-4">
            <RepoIcon visual={topicVisual(topic)} size="row" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <Link
                to="/topics/$topic"
                params={{ topic: topic.topic }}
                className="truncate font-display text-[19px] leading-6 font-semibold tracking-snug outline-none after:absolute after:inset-0 after:squircle after:rounded-tile focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
              >
                {topic.topic}
              </Link>
              <span className="font-sans text-sm text-muted-foreground tabular-nums">
                {`${formatCount(topic.ranked)} ranked · ${formatCount(topic.repos)} repos`}
              </span>
            </span>
          </Tile>
        </li>
      ))}
    </ol>
  );
}

// Every GitHub topic with a page: the most ranked first, and a field that finds one by its name.
export function TopicsPage() {
  const { first } = useLoaderData({ from: "/topics/" });
  const [typed, setTyped] = useState("");
  const finding = useFound(typed);
  const field = useId();
  return (
    <Page here="discover">
      <section className="flex flex-col gap-3.5 pt-1.5 sm:pt-5">
        <h1 className="flex items-baseline gap-3 font-display text-3xl leading-10 font-semibold tracking-tight sm:text-[52px] sm:leading-[56px]">
          topics
          {first.kind === "found" && first.list.total > 0 && (
            <span className="font-sans text-base font-normal tracking-normal text-muted-foreground tabular-nums sm:text-lg">
              {formatCount(first.list.total)}
            </span>
          )}
        </h1>
        <search>
          <form
            onSubmit={(event) => event.preventDefault()}
            className="flex h-12 items-center rounded-full bg-card px-5 font-sans text-lg focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring sm:h-14 lg:max-w-[620px]"
          >
            <label htmlFor={field} className="sr-only">
              find a topic
            </label>
            <input
              id={field}
              type="search"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="find a topic, such as nextjs or rust"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={50}
              className="h-full min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
            />
          </form>
        </search>
      </section>
      {finding !== undefined ? (
        <Finding {...finding} />
      ) : first.kind === "failed" ? (
        <Unloaded />
      ) : first.list.topics.length === 0 ? (
        <EmptyTile pose="unsure" heading="no topics yet" body="topic pages fill in overnight." />
      ) : (
        <TopicGrid topics={first.list.topics} />
      )}
    </Page>
  );
}
