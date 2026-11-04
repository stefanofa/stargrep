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

export function useSemanticSearch(login: string, query: string): Semantic {
  const [answer, setAnswer] = useState<Answer<ReadonlyArray<SearchResult>, SearchFailed>>();
  const search = useRef<Search>(undefined);

  useEffect(() => {
    const running = startSemanticSearch(
      (q, signal) =>
        api()
          .search({ login, q }, { signal })
          .then(({ results }) => results),
      setAnswer,
    );
    search.current = running;
    return () => {
      running.stop();
      search.current = undefined;
    };
  }, [login]);

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
