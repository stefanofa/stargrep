import { useEffect, useRef, useState } from "react";
import { normalize } from "./keyword.ts";
import { api, type SearchResult, wireCode } from "./rpc.ts";
import { minimumLength, pauseMillis } from "./search-pace.ts";
import { topicSearch } from "./topic-search.ts";

// The last answer the topic's search got, and the query it answers.
type Answer =
  | { readonly q: string; readonly kind: "found"; readonly results: ReadonlyArray<SearchResult> }
  | { readonly q: string; readonly kind: "failed"; readonly limited: boolean };

// What the page shows for the typed query. Too short a query shows the topic's own lists. While the next answer is on its
// way, the last results stay on screen, so the list doesn't flash on every pause in the typing.
export type TopicSearch =
  | { readonly kind: "idle" }
  | { readonly kind: "searching"; readonly earlier: ReadonlyArray<SearchResult> }
  | { readonly kind: "found"; readonly results: ReadonlyArray<SearchResult> }
  | { readonly kind: "none"; readonly q: string }
  | { readonly kind: "failed"; readonly limited: boolean };

export const topicSearchView = (q: string, answer: Answer | undefined): TopicSearch => {
  if (q.length < minimumLength) return { kind: "idle" };
  if (answer?.q !== q) return { kind: "searching", earlier: answer?.kind === "found" ? answer.results : [] };
  if (answer.kind === "failed") return { kind: "failed", limited: answer.limited };
  return answer.results.length === 0 ? { kind: "none", q } : { kind: "found", results: answer.results };
};

// Searches the topic's repos as you type: a query is asked once the typing rests, and a newer one cancels it. The query
// a page opens with, such as a shared link's, is asked at once.
export function useTopicSearch(topic: string, typed: string) {
  const q = normalize(typed);
  const [answer, setAnswer] = useState<Answer>();
  const [round, setRound] = useState(0);
  const opened = useRef(true);
  useEffect(() => {
    const first = opened.current;
    opened.current = false;
    if (q.length < minimumLength) return;
    const asking = new AbortController();
    const ask = () =>
      api()
        .search(topicSearch(topic, q), { signal: asking.signal })
        .then(
          ({ results }) => !asking.signal.aborted && setAnswer({ q, kind: "found", results }),
          (error: unknown) =>
            !asking.signal.aborted &&
            setAnswer({ q, kind: "failed", limited: wireCode(error) === "TOO_MANY_REQUESTS" }),
        );
    // @effect-diagnostics-next-line globalTimers:off - topic pages load no Effect, so the wait uses the platform's timer.
    const timer = setTimeout(ask, first ? 0 : pauseMillis);
    return () => {
      clearTimeout(timer);
      asking.abort();
    };
  }, [topic, q, round]);
  // Asking again drops the failed answer, so the page shows the search running until the new answer lands.
  const retry = () => {
    setAnswer(undefined);
    setRound((count) => count + 1);
  };
  return { search: topicSearchView(q, answer), retry };
}
