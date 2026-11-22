import { EmptyTile, Tile } from "@stargrep/ui";
import { Link, useLoaderData } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { api, type TopicCount, type TopicsList } from "../lib/rpc.ts";
import { formatCount } from "../lib/whose.ts";
import { Page } from "./page.tsx";
import { SiteHeader } from "./site-header.tsx";

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

// The topics whose names hold the typed text, asked a moment after the typing stops. Undefined while nothing is typed.
const useFound = (typed: string) => {
  const [found, setFound] = useState<{ readonly q: string; readonly topics: ReadonlyArray<TopicCount> }>();
  const q = typed.trim().toLowerCase();
  useEffect(() => {
    if (q === "") return;
    let current = true;
    // @effect-diagnostics-next-line globalTimers:off - topic pages load no Effect, so the wait uses the platform's timer.
    const timer = setTimeout(() => {
      api()
        .listTopics({ q, limit: 60 })
        .then(
          ({ topics }) => current && setFound({ q, topics }),
          () => current && setFound({ q, topics: [] }),
        );
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q]);
  if (q === "") return undefined;
  return found?.q === q ? found.topics : "asking";
};

function TopicGrid({ topics }: { topics: ReadonlyArray<TopicCount> }) {
  return (
    <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {topics.map((topic) => (
        <li key={topic.topic} className="flex min-w-0">
          <Tile className="relative flex min-w-0 flex-1 flex-col gap-0.5 px-5 py-4">
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
          </Tile>
        </li>
      ))}
    </ol>
  );
}

// Every GitHub topic with a page: the most ranked first, and a field that finds one by its name.
export function TopicsPage() {
  const { viewer, repoStars } = useLoaderData({ from: "__root__" });
  const { first } = useLoaderData({ from: "/topics/" });
  const [typed, setTyped] = useState("");
  const found = useFound(typed);
  const field = useId();
  return (
    <Page header={<SiteHeader viewer={viewer} repoStars={repoStars} />}>
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
      {found !== undefined ? (
        found === "asking" ? (
          <p role="status" className="font-sans text-meta text-muted-foreground">
            looking…
          </p>
        ) : found.length === 0 ? (
          <EmptyTile
            pose="unsure"
            heading="no topic like that"
            body="a topic gets a page once enough developers star its repos."
          />
        ) : (
          <TopicGrid topics={found} />
        )
      ) : first.kind === "failed" ? (
        <EmptyTile pose="scared" heading="couldn't load topics" body="stargrep couldn't read the topics just now." />
      ) : first.list.topics.length === 0 ? (
        <EmptyTile pose="unsure" heading="no topics yet" body="topic pages fill in overnight." />
      ) : (
        <TopicGrid topics={first.list.topics} />
      )}
    </Page>
  );
}
