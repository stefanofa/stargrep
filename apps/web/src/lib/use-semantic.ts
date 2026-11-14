import * as Result from "effect/Result";
import { useEffect, useRef, useState } from "react";
import { normalize } from "./keyword.ts";
import { hitsOf, type Semantic } from "./page-view.ts";
import { api, type SearchResult, wireCode } from "./rpc.ts";
import { type Answer, minimumLength, type SearchFailed, startSemanticSearch } from "./search-stream.ts";

type Search = ReturnType<typeof startSemanticSearch<ReadonlyArray<SearchResult>>>;

export type { Semantic };

const none: Semantic = { kind: "none" };

// An answer the page already has, and the library revision it was answered from.
export interface Known {
  readonly query: string;
  readonly results: ReadonlyArray<SearchResult>;
  readonly revision: string;
}

export function useSemanticSearch(
  login: string,
  query: string,
  { revision, settled, known }: { revision: string | undefined; settled: boolean; known?: Known | undefined },
): { readonly semantic: Semantic; readonly retry: () => void } {
  const [answer, setAnswer] = useState<Answer<ReadonlyArray<SearchResult>, SearchFailed> | undefined>(
    known && { query: normalize(known.query), result: Result.succeed(known.results) },
  );
  const search = useRef<Search>(undefined);
  // The library revision the answer on screen was searched in. Once the library settles on another one, a search by
  // meaning asks again, since the answer may describe stars that changed.
  const answeredIn = useRef(known?.revision);
  const [answered] = useState(known?.query);

  useEffect(() => {
    const client = api();
    const running = startSemanticSearch(
      (q, signal) =>
        client.search({ scope: { kind: "stars", login }, q }, { signal }).then(
          ({ results }) => results,
          // A login whose import hasn't created its account yet has no stars to find. The page shows the import, and
          // the search asks again once reading settles.
          (error: unknown) => {
            if (wireCode(error) === "ACCOUNT_NOT_SYNCED") return [];
            throw error;
          },
        ),
      setAnswer,
      answered,
    );
    search.current = running;
    return () => {
      running.stop();
      search.current = undefined;
    };
  }, [login, answered]);

  useEffect(() => {
    search.current?.offer(query);
  }, [query]);

  useEffect(() => {
    if (revision === undefined) return;
    const before = answeredIn.current;
    if (settled && before !== undefined && before !== revision) search.current?.refresh();
    if (settled || before === undefined) answeredIn.current = revision;
  }, [revision, settled]);

  // Asking again drops the failed answer, so the page shows the search pending until the new answer lands.
  const retry = () => {
    setAnswer(undefined);
    search.current?.refresh();
  };

  const wanted = normalize(query);
  const landed: Semantic =
    answer?.result === undefined
      ? none
      : Result.match(answer.result, {
          onSuccess: (results) => ({ kind: "answered", results }),
          onFailure: ({ cause }) => ({ kind: wireCode(cause) === "TOO_MANY_REQUESTS" ? "limited" : "failed" }),
        });
  if (answer?.query === wanted) return { semantic: landed, retry };
  if (wanted.length < minimumLength) return { semantic: none, retry };
  return { semantic: { kind: "pending", results: hitsOf(landed) }, retry };
}
