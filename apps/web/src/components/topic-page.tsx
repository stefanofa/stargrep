import { Button, buttonVariants, Chip, EmptyTile, RepoPanel, SearchTile, Tile } from "@stargrep/ui";
import { Link, useLoaderData, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useRepoParam } from "../lib/panel-history.ts";
import { plainDetail } from "../lib/plain-detail.ts";
import { api, type Topic, type TopicRepo, wireCode } from "../lib/rpc.ts";
import { topicSearchLimit } from "../lib/topic-search.ts";
import { type TopicSearch, useTopicSearch } from "../lib/use-topic-search.ts";
import { textLinkClass } from "./external-text-link.tsx";
import { Page } from "./page.tsx";
import { type ListedRepo, type OpenListed, RepoList } from "./repo-list.tsx";
import { TopicChips } from "./topic-chips.tsx";
import { TopicTile } from "./topic-tile.tsx";

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

const byPeople = (a: TopicRepo, b: TopicRepo) => b.devs - a.devs || (b.stars ?? 0) - (a.stars ?? 0);

// The topic's repos as people here star them, its own repo in its place among them.
const rankedOf = ({ home, core }: Topic): ReadonlyArray<TopicRepo> =>
  home === null ? core : [...core, home].toSorted(byPeople);

// The stars page's words for a search that didn't answer, and for a network that asked too often.
const missed = {
  failed: {
    pose: "scared",
    heading: "stargrep couldn't search that",
    body: "the search didn't answer. try again in a moment.",
  },
  limited: { pose: "unsure", heading: "lots of searches from your network", body: "give it a minute, then try again." },
} as const;

const step = 12;

// The repos under the search: the topic's own, most starred by people here, or what the search found.
function Repos({
  topic,
  ranked,
  search,
  retry,
  onOpen,
}: {
  topic: string;
  ranked: ReadonlyArray<TopicRepo>;
  search: TopicSearch;
  retry: () => void;
  onOpen: OpenListed;
}) {
  const [shown, setShown] = useState(step);
  switch (search.kind) {
    case "idle":
      return (
        <RepoList
          heading="most starred by people here"
          repos={ranked.slice(0, shown)}
          ranked
          more={ranked.length > shown ? () => setShown((count) => count + step * 3) : undefined}
          onOpen={onOpen}
        />
      );
    case "searching":
      return (
        <RepoList
          heading="searching…"
          repos={search.earlier.length === 0 ? undefined : search.earlier}
          busy
          onOpen={onOpen}
        />
      );
    case "found":
      return (
        <RepoList
          heading={`found ${search.results.length}${search.results.length === topicSearchLimit ? "+" : ""}`}
          repos={search.results}
          onOpen={onOpen}
        />
      );
    case "none":
      return (
        <EmptyTile
          pose="sad"
          heading="nothing matches that"
          body={`no ${topic} repo matches "${search.q}". try other words.`}
        />
      );
    case "failed":
      return (
        <EmptyTile {...missed[search.limited ? "limited" : "failed"]}>
          <Button variant="primary" size="lg" className="mt-2" onClick={retry}>
            try again
          </Button>
        </EmptyTile>
      );
  }
}

const chipPlates = { none: "bg-card", light: "bg-[#ffffff]", dark: "bg-ink" } as const;

function Related({ topic }: { topic: Topic }) {
  return (
    <Tile className="flex min-w-0 flex-col gap-3 px-5 pt-5 pb-5 sm:px-6 sm:pt-6 sm:pb-[22px]">
      <h2 className="font-display text-xl leading-7 font-semibold tracking-snug">related</h2>
      <nav aria-label="related topics">
        <ul className="flex flex-wrap gap-2">
          {topic.related.map(({ topic: name, icon }) => (
            <li key={name}>
              <Chip
                render={<Link to="/topics/$topic" params={{ topic: name }} />}
                className={`h-[30px] ${icon === null ? "px-3" : "gap-1.5 pr-3 pl-[3px]"}`}
              >
                {icon !== null && (
                  <img
                    src={icon.url}
                    alt=""
                    width={24}
                    height={24}
                    loading="lazy"
                    decoding="async"
                    className={`size-6 shrink-0 rounded-full object-cover outline-1 -outline-offset-1 outline-image-edge ${chipPlates[icon.plate]}`}
                  />
                )}
                {name}
              </Chip>
            </li>
          ))}
        </ul>
      </nav>
      <Link to="/topics" className={`${textLinkClass} self-start font-sans text-meta font-medium`}>
        all topics →
      </Link>
    </Tile>
  );
}

// A GitHub topic's page: the topic and the people into it, a search over all of its repos as you type, the repos people
// here star most, and topics nearby. A row opens the repo panel through ?repo=.
function TopicView({ topic }: { topic: Topic }) {
  const params = useSearch({ from: "/topics/$topic" });
  const navigate = useNavigate();
  const [query, setQuery] = useState(params.q ?? "");
  const { search, retry } = useTopicSearch(topic.topic, query);
  // Typing replaces ?q= as it goes, so a search is a link to share without filling the history.
  const type = (next: string) => {
    setQuery(next);
    void navigate({
      to: ".",
      search: (previous) => ({ ...previous, q: next.trim() === "" ? undefined : next }),
      replace: true,
    });
  };

  const ranked = rankedOf(topic);
  const found = search.kind === "found" ? search.results : search.kind === "searching" ? search.earlier : [];
  const panel = useRepoParam();
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const onOpen: OpenListed = (repo, link) => {
    setOpener(link);
    void panel.open(repo);
  };
  // The panel keeps the last repo it showed while it slides closed.
  const [panelRepo, setPanelRepo] = useState(params.repo);
  if (params.repo !== undefined && params.repo !== panelRepo) setPanelRepo(params.repo);
  const opened = [...ranked, ...found].find((repo: ListedRepo) => `${repo.owner}/${repo.name}` === panelRepo);
  // @effect-diagnostics-next-line globalDate:off - topic pages load no Effect, so the panel reads the platform's clock.
  const [at] = useState(() => Date.now());

  return (
    <Page here="discover" dock>
      <TopicTile topic={topic} query={query.trim() === "" ? undefined : query.trim()} />
      <SearchTile
        query={query}
        onQueryChange={type}
        label={`Search ${topic.topic} repos`}
        placeholder={`search ${topic.topic} repos in plain words`}
      />
      <div className="grid items-start gap-gap lg:grid-cols-[minmax(0,780fr)_minmax(0,400fr)]">
        <Repos topic={topic.topic} ranked={ranked} search={search} retry={retry} onOpen={onOpen} />
        {topic.related.length > 0 && <Related topic={topic} />}
      </div>
      <RepoPanel
        repo={opened && plainDetail(opened, "devs" in opened ? opened.stars : null, at)}
        open={params.repo !== undefined && opened !== undefined}
        onOpenChange={(next) => {
          if (!next) panel.close();
        }}
        returnFocus={opener}
        topics={<TopicChips topics={opened?.topics ?? []} />}
      />
    </Page>
  );
}

// Another topic is another page, with its own search.
export function TopicPage() {
  const { topic } = useLoaderData({ from: "/topics/$topic" });
  return <TopicView key={topic.topic} topic={topic} />;
}

// A topic without a page: say so, and lead to the topics that have one.
export function TopicMissing() {
  return (
    <Page here="discover">
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
