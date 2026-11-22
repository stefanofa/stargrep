import type { SearchResult, Topic } from "../../lib/rpc.ts";
import type { TopMatch } from "./account.ts";

export interface TopicRepoLine {
  readonly owner: string;
  readonly name: string;
  readonly devs: number;
}

// What a topic's card shows: its name, both counts, and its three most starred core repos with how many developers star
// each. A shared search shows its query and its best match instead, when the answer cache holds one.
export interface TopicCardData {
  readonly topic: string;
  readonly repos: number;
  readonly ranked: number;
  readonly top: ReadonlyArray<TopicRepoLine>;
  readonly search: { readonly query: string; readonly top: TopMatch | null } | null;
}

export interface TopicCardSource {
  readonly topic: (topic: string) => Promise<Topic>;
  // The answer the API's answer cache already holds for the topic's search, or nothing. A card never starts a search.
  readonly cachedTopicResults: (topic: string, query: string) => Promise<ReadonlyArray<SearchResult>>;
}

export const readTopicCard = async (
  { topic, cachedTopicResults }: TopicCardSource,
  typed: string,
  q: string,
): Promise<TopicCardData> => {
  const query = q.trim().replace(/\s+/g, " ");
  const page = await topic(typed);
  const [first] = query === "" ? [] : await cachedTopicResults(page.topic, query);
  return {
    topic: page.topic,
    repos: page.repos,
    ranked: page.ranked,
    top: page.core.slice(0, 3).map(({ owner, name, devs }) => ({ owner, name, devs })),
    search:
      query === ""
        ? null
        : {
            query,
            top:
              first === undefined
                ? null
                : { owner: first.owner, name: first.name, about: first.description ?? first.summary },
          },
  };
};
