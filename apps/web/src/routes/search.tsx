import {
  Button,
  Mascot,
  type OpenResult,
  RepoPanel,
  Results,
  ResultsSummary,
  ScopeSwitch,
  SearchTile,
  Skeleton,
  type Sort,
  SyncProgress,
  Tile,
  useStoredView,
  type View,
  ViewToggle,
} from "@stargrep/ui";
import { and, ilike } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AccountMenu } from "../components/account-menu.tsx";
import { LibraryView, type Syncing } from "../components/library-view.tsx";
import { Page } from "../components/page.tsx";
import { SignInButton } from "../components/sign-in-button.tsx";
import { Wordmark } from "../components/wordmark.tsx";
import { keywordTerms } from "../lib/keyword.ts";
import { getLibrary, useRecoveries } from "../lib/library-collection.ts";
import { formatCount, now, stars, syncedAgo, toDetail } from "../lib/present.ts";
import { mergeResults, withReply } from "../lib/results.ts";
import { api, signedOut, type Viewer } from "../lib/rpc.ts";
import { useSemanticSearch } from "../lib/use-semantic.ts";
import { useSync } from "../lib/use-sync.ts";

interface Params {
  readonly q?: string | undefined;
  readonly view?: View | undefined;
  readonly sort?: Sort | undefined;
  readonly lang?: string | undefined;
  readonly repo?: string | undefined;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

// The route's options stay in the entry chunk, so they import nothing from the UI package.
const sortValues: ReadonlyArray<unknown> = ["starred", "stars", "pushed"] satisfies ReadonlyArray<Sort>;

const isSort = (value: unknown): value is Sort => sortValues.includes(value);

export const Route = createFileRoute("/search")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): Params => {
    const [q, lang, repo] = [text(search.q), text(search.lang), text(search.repo)];
    return {
      ...(q === undefined ? {} : { q }),
      ...(search.view === "list" || search.view === "tiles" ? { view: search.view } : {}),
      ...(isSort(search.sort) ? { sort: search.sort } : {}),
      ...(lang === undefined ? {} : { lang }),
      ...(repo === undefined ? {} : { repo }),
    };
  },
  component: SearchPage,
});

type ViewerState =
  | { readonly status: "loading" }
  | { readonly status: "signed-out" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly viewer: Viewer };

function useViewer() {
  const [state, setState] = useState<ViewerState>({ status: "loading" });
  useEffect(() => {
    api()
      .viewer()
      .then(
        (viewer) => setState({ status: "ready", viewer }),
        (error: unknown) => setState({ status: signedOut(error) ? "signed-out" : "failed" }),
      );
  }, []);
  return state;
}

const scopes = [{ value: "stars", label: "Your stars", href: "/search" }];

function SearchPage() {
  const state = useViewer();
  return (
    <Page
      header={
        <>
          <Wordmark />
          <ScopeSwitch scopes={scopes} value="stars" className="max-sm:hidden" />
          {state.status === "ready" ? (
            <AccountMenu login={state.viewer.login} avatarUrl={state.viewer.avatarUrl} />
          ) : (
            <SignInButton />
          )}
        </>
      }
    >
      {state.status === "loading" && <Loading />}
      {state.status === "signed-out" && (
        <Notice
          heading="sign in to search your stars"
          mood="searching"
          action={<SignInButton variant="primary" size="lg" />}
        />
      )}
      {state.status === "failed" && (
        <Notice heading="stargrep couldn't load your account" detail="try again in a moment" mood="surprised" />
      )}
      {state.status === "ready" && <Library viewer={state.viewer} />}
    </Page>
  );
}

function Notice({
  heading,
  detail,
  mood,
  action,
}: {
  heading: string;
  detail?: string;
  mood: "searching" | "surprised" | "flat";
  action?: ReactNode;
}) {
  return (
    <Tile className="relative flex min-h-[240px] flex-col justify-center gap-6 px-tile-lg py-10 sm:px-12">
      <div className="relative z-10 flex max-w-[640px] flex-col gap-2">
        <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-display sm:leading-[56px]">
          {heading}
        </h2>
        {detail && <p className="font-sans text-lg text-secondary-foreground">{detail}</p>}
      </div>
      {action && <div className="relative z-10">{action}</div>}
      <Mascot mood={mood} size={200} className="absolute top-8 right-[88px] -rotate-12 max-md:hidden" />
    </Tile>
  );
}

function Loading() {
  return (
    <Results
      view="tiles"
      results={[]}
      pending={6}
      summary={
        <ResultsSummary
          heading={
            <>
              <span className="sr-only">loading</span>
              <Skeleton aria-hidden className="h-11 w-[236px]" />
            </>
          }
          detail={<Skeleton className="mt-2 h-3 w-[148px]" />}
          mood="searching"
        />
      }
    />
  );
}

type Text = Parameters<typeof ilike>[0];

const containsEvery = (text: Text, [first, ...rest]: readonly [string, ...Array<string>]) => {
  const [second, ...others] = rest.map((term) => ilike(text, `%${term}%`));
  const head = ilike(text, `%${first}%`);
  return second === undefined ? head : and(head, second, ...others);
};

function useTimeLeft(done: number, total: number, syncing: boolean) {
  const [first, setFirst] = useState<{ readonly at: number; readonly done: number }>();
  useEffect(() => {
    if (!syncing) setFirst(undefined);
    else setFirst((current) => current ?? { at: now(), done });
  }, [syncing, done]);
  if (!syncing || first === undefined) return syncing ? "starting" : "";
  const perSecond = (done - first.done) / Math.max(1, (now() - first.at) / 1000);
  if (perSecond <= 0) return "starting";
  const seconds = Math.ceil((total - done) / perSecond);
  if (seconds <= 5) return "almost done";
  return seconds < 90 ? `about ${seconds} seconds left` : `about ${Math.round(seconds / 60)} minutes left`;
}

function Library({ viewer }: { viewer: Viewer }) {
  const recoveries = useRecoveries(getLibrary());
  return <Stars key={recoveries} viewer={viewer} />;
}

function Stars({ viewer }: { viewer: Viewer }) {
  const { collection: library, reload } = getLibrary();
  const [retrying, setRetrying] = useState(false);
  const [at] = useState(now);
  const params = Route.useSearch();
  const navigate = Route.useNavigate();
  const [storedView, storeView] = useStoredView();
  const view = params.view ?? storedView;
  const [query, setQuery] = useState(params.q ?? "");
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const terms = useMemo(() => keywordTerms(query), [query]);

  const { data: entries, isReady, isLoadingError } = useLiveQuery((q) => q.from({ repo: library }));
  const { data: matched = [] } = useLiveQuery((q) => {
    const [first, ...rest] = terms;
    return first === undefined
      ? undefined
      : q.from({ repo: library }).where(({ repo }) => containsEvery(repo.text, [first, ...rest]));
  });
  const semantic = useSemanticSearch(viewer.login, query);
  const { status: sync, retry } = useSync(viewer.login, reload);

  const syncingNow = sync?.state === "queued";
  const total = Math.max(viewer.starredCount ?? 0, entries.length);
  const timeLeft = useTimeLeft(entries.length, total, syncingNow);
  const syncing: Syncing | undefined = syncingNow ? { total, timeLeft } : undefined;

  const retryLibrary = () => {
    setRetrying(true);
    reload().finally(() => setRetrying(false));
  };
  const search = (next: string) => {
    setQuery(next);
    navigate({ search: (previous) => ({ ...previous, q: next === "" ? undefined : next }), replace: true });
  };
  const setView = (next: View) => {
    storeView(next);
    navigate({ search: (previous) => ({ ...previous, view: next }), replace: true });
  };
  const open: OpenResult = (result, link) => {
    setOpener(link);
    navigate({ search: (previous) => ({ ...previous, repo: `${result.owner}/${result.name}` }) });
  };
  const entry =
    params.repo === undefined ? undefined : entries.find((repo) => `${repo.owner}/${repo.name}` === params.repo);
  const hit = semantic.results.find((result) => result.id === entry?.id);
  const opened = entry && (hit ? withReply(entry, hit) : entry);

  const searching = terms.length > 0 || semantic.pending || semantic.results.length > 0;
  const results = useMemo(
    () => mergeResults({ matched, terms, hits: semantic.results, find: (id) => library.get(id), at }),
    [matched, terms, semantic.results, library, at],
  );

  const syncedNote =
    sync?.state === "failed" ? (
      <button
        type="button"
        onClick={retry}
        className="flex h-9 items-center rounded-full bg-[#ffffff] px-4 font-sans text-meta font-semibold text-ink"
      >
        sync didn't finish · try again
      </button>
    ) : (
      sync?.syncedAt && (
        <span className="flex h-9 w-fit items-center rounded-full bg-[#ffffff] px-4 font-sans text-meta font-semibold text-ink">
          {syncedAgo(sync.syncedAt, at)}
        </span>
      )
    );

  return (
    <>
      <div className="max-sm:fixed max-sm:inset-x-4 max-sm:bottom-[max(16px,env(safe-area-inset-bottom))] max-sm:z-30 max-sm:[&>div]:shadow-[0_10px_40px_#1e1b2e29]">
        <SearchTile query={query} onQueryChange={search} label="Search your stars" />
      </div>
      <div className="flex flex-col gap-gap max-sm:pb-28">
        {isLoadingError ? (
          <Notice
            heading="stargrep couldn't load your stars"
            detail="the library didn't arrive"
            mood="surprised"
            action={
              <Button variant="primary" size="lg" disabled={retrying} onClick={retryLibrary}>
                Try again
              </Button>
            }
          />
        ) : !isReady ? (
          <Loading />
        ) : searching ? (
          results.length === 0 && !semantic.pending ? (
            <Notice heading="nothing matches that" mood="flat" />
          ) : (
            <Results
              view={view}
              results={results}
              pending={semantic.pending ? (results.length === 0 ? 6 : 2) : 0}
              onOpen={open}
              summary={
                <ResultsSummary
                  heading={
                    syncing ? "syncing" : results.length === 0 ? "searching" : `found ${formatCount(results.length)}!`
                  }
                  detail={
                    syncing ? (
                      <SyncProgress done={entries.length} total={total} timeLeft={timeLeft} />
                    ) : (
                      `of your ${stars(entries.length)}`
                    )
                  }
                  mood={syncing ? "delighted" : results.length === 0 ? "searching" : "happy"}
                  motion="blink"
                  controls={<ViewToggle value={view} onValueChange={setView} />}
                />
              }
            />
          )
        ) : (
          <LibraryView
            entries={entries}
            at={at}
            view={view}
            onViewChange={setView}
            sort={params.sort ?? "starred"}
            onSortChange={(sort) => navigate({ search: (previous) => ({ ...previous, sort }), replace: true })}
            language={params.lang}
            syncing={syncing}
            synced={syncedNote}
            onOpen={open}
          />
        )}
      </div>
      <RepoPanel
        repo={opened && toDetail(opened, at)}
        open={opened !== undefined}
        onOpenChange={(next) => {
          if (!next) navigate({ search: (previous) => ({ ...previous, repo: undefined }) });
        }}
        returnFocus={opener}
      />
    </>
  );
}
