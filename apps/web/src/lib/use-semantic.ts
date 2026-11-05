import * as Result from "effect/Result";
import { useEffect, useRef, useState } from "react";
import { normalize } from "./keyword.ts";
import { api, type SearchResult } from "./rpc.ts";
import { type Answer, minimumLength, type SearchFailed, startSemanticSearch } from "./search-stream.ts";

type Search = ReturnType<typeof startSemanticSearch<ReadonlyArray<SearchResult>>>;

export interface Semantic {
  readonly results: ReadonlyArray<SearchResult>;
  readonly pending: boolean;
  readonly failed: boolean;
}

const none: Semantic = { results: [], pending: false, failed: false };

// A new `round` restarts the search and asks the current query again, so a search made while stars were still being
// read reruns once reading finishes.
export function useSemanticSearch(login: string, query: string, round = 0): Semantic {
  const [answer, setAnswer] = useState<Answer<ReadonlyArray<SearchResult>, SearchFailed>>();
  const search = useRef<Search>(undefined);
  const latest = useRef(query);
  latest.current = query;

  useEffect(() => {
    const running = startSemanticSearch(
      (q, signal) =>
        api()
          .search({ login, q }, { signal })
          .then(({ results }) => results),
      setAnswer,
    );
    search.current = running;
    if (round > 0) running.offer(latest.current);
    return () => {
      running.stop();
      search.current = undefined;
    };
  }, [login, round]);

  useEffect(() => {
    search.current?.offer(query);
  }, [query]);

  const wanted = normalize(query);
  if (answer?.query !== wanted) return { ...none, pending: wanted.length >= minimumLength };
  if (answer.result === undefined) return none;
  return Result.match(answer.result, {
    onSuccess: (results) => ({ ...none, results }),
    onFailure: () => ({ ...none, failed: true }),
  });
}
