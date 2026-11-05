import {
  Button,
  EmptyTile,
  type OpenResult,
  Pip,
  type PipPose,
  RephraseChips,
  RepoPanel,
  Results,
  ScopeSwitch,
  SearchTile,
  Skeleton,
  type Sort,
  SortMenu,
  StatusLine,
  Tile,
  useStoredView,
  type View,
  ViewToggle,
} from "@stargrep/ui";
import { and, ilike } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute } from "@tanstack/react-router";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AccountMenu } from "../components/account-menu.tsx";
import { LibraryPlaceholder, LibraryView } from "../components/library-view.tsx";
import { Page } from "../components/page.tsx";
import { SignInButton } from "../components/sign-in-button.tsx";
import { Wordmark } from "../components/wordmark.tsx";
import { keywordTerms } from "../lib/keyword.ts";
import { getLibrary, useRecoveries } from "../lib/library-collection.ts";
import { orders } from "../lib/order.ts";
import { now, syncedAgo, toDetail } from "../lib/present.ts";
import { mergeResults, withReply } from "../lib/results.ts";
import { api, signedOut, type Viewer } from "../lib/rpc.ts";
import { type Body, type Stage, searchView, stageOf } from "../lib/search-state.ts";
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
const searchSorts: ReadonlyArray<Sort> = ["best", "starred", "stars", "pushed"];
const librarySorts = searchSorts.filter((sort) => sort !== "best");

const isSort = (value: unknown): value is Sort => searchSorts.some((sort) => sort === value);

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
  const [pose, setPose] = useState<PipPose>("idle");
  return (
    <Page
      header={
        <>
          <Wordmark pose={state.status === "failed" ? "scared" : pose} />
          <ScopeSwitch scopes={scopes} value="stars" className="max-sm:hidden" />
          {state.status === "ready" ? (
            <AccountMenu login={state.viewer.login} avatarUrl={state.viewer.avatarUrl} />
          ) : state.status === "loading" ? (
            <Skeleton className="size-11 shrink-0" />
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
          pose="idle"
          action={<SignInButton variant="primary" size="lg" />}
        />
      )}
      {state.status === "failed" && (
        <Notice heading="stargrep couldn't load your account" detail="try again in a moment" pose="scared" />
      )}
      {state.status === "ready" && <Library viewer={state.viewer} onPose={setPose} />}
    </Page>
  );
}

function Notice({
  heading,
  detail,
  pose,
  action,
}: {
  heading: string;
  detail?: string;
  pose: PipPose;
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
      <Pip pose={pose} size={200} className="absolute top-5 right-[88px] -rotate-12 max-md:hidden" />
    </Tile>
  );
}

const dock =
  "max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[max(16px,env(safe-area-inset-bottom))] max-sm:z-30 max-sm:[&_[data-slot=tile]]:shadow-dock";

function useControls(searching: boolean) {
  const params = Route.useSearch();
  const navigate = Route.useNavigate();
  const [storedView, storeView] = useStoredView();
  const view = params.view ?? storedView;
  const sort = params.sort ?? (searching ? "best" : "starred");
  const setView = (next: View) => {
    storeView(next);
    navigate({ search: (previous) => ({ ...previous, view: next }), replace: true });
  };
  const setSort = (next: Sort) => navigate({ search: (previous) => ({ ...previous, sort: next }), replace: true });
  const controls = (
    <>
      <SortMenu value={sort} onValueChange={setSort} options={searching ? searchSorts : librarySorts} />
      <ViewToggle value={view} onValueChange={setView} />
    </>
  );
  return { view, sort, controls };
}

function Waiting({ view, searching }: { view: View; searching: boolean }) {
  return searching ? (
    <Results view={view} groups={[{ key: "all", results: [], pending: 4 }]} />
  ) : (
    <LibraryPlaceholder view={view} />
  );
}

const loadingStatus = <StatusLine icon="busy" label="loading your stars" />;

function Loading() {
  const params = Route.useSearch();
  const navigate = Route.useNavigate();
  const searching = keywordTerms(params.q ?? "").length > 0;
  const { view, controls } = useControls(searching);
  return (
    <>
      <SearchTile
        query={params.q ?? ""}
        onQueryChange={(next) =>
          navigate({ search: (previous) => ({ ...previous, q: next === "" ? undefined : next }), replace: true })
        }
        label="Search your stars"
        placeholder={idlePlaceholder}
        className={dock}
        status={loadingStatus}
        controls={controls}
      />
      <div className="flex flex-col gap-gap max-sm:pb-44">
        <Waiting view={view} searching={searching} />
      </div>
    </>
  );
}

const idlePlaceholder = "the rust tui library I starred last year";

type Text = Parameters<typeof ilike>[0];

const containsEvery = (text: Text, [first, ...rest]: readonly [string, ...Array<string>]) => {
  const [second, ...others] = rest.map((term) => ilike(text, `%${term}%`));
  const head = ilike(text, `%${first}%`);
  return second === undefined ? head : and(head, second, ...others);
};

const measured = (stage: Stage) => {
  if (stage.name === "importing") return { done: stage.done, total: stage.total };
  if (stage.name === "reading") return { done: stage.settled, total: stage.total };
  return undefined;
};

function useTimeLeft(stage: Stage) {
  const [stageStart, setStageStart] = useState<{
    readonly stage: Stage["name"];
    readonly at: number;
    readonly done: number;
  }>();
  const progress = measured(stage);
  const done = progress?.done ?? 0;
  const total = progress?.total ?? null;
  const active = progress !== undefined;
  useEffect(() => {
    if (!active) setStageStart(undefined);
    else setStageStart((current) => (current?.stage === stage.name ? current : { stage: stage.name, at: now(), done }));
  }, [active, stage.name, done]);
  if (!active || stageStart === undefined || total === null) return undefined;
  const perSecond = (done - stageStart.done) / Math.max(1, (now() - stageStart.at) / 1000);
  if (perSecond <= 0) return undefined;
  const seconds = Math.ceil((total - done) / perSecond);
  if (seconds <= 5) return "almost done";
  return seconds < 90 ? `about ${seconds} seconds left` : `about ${Math.round(seconds / 60)} minutes left`;
}

function useSurprise(landed: number) {
  const [surprised, setSurprised] = useState(false);
  useEffect(() => {
    if (landed === 0) return;
    setSurprised(true);
    const fiber = Effect.runFork(
      Effect.sleep(Duration.millis(1200)).pipe(Effect.andThen(Effect.sync(() => setSurprised(false)))),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [landed]);
  return surprised;
}

function Library({ viewer, onPose }: { viewer: Viewer; onPose: (pose: PipPose) => void }) {
  const recoveries = useRecoveries(getLibrary());
  return <Stars key={recoveries} viewer={viewer} onPose={onPose} />;
}

function Stars({ viewer, onPose }: { viewer: Viewer; onPose: (pose: PipPose) => void }) {
  const { collection: library, reload } = getLibrary();
  const [retrying, setRetrying] = useState(false);
  const [at] = useState(now);
  const params = Route.useSearch();
  const navigate = Route.useNavigate();
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
  const { status: sync, retry } = useSync(viewer.login, reload);
  const stage = stageOf({ sync, entries, starred: viewer.starredCount });
  const timeLeft = useTimeLeft(stage);
  const semantic = useSemanticSearch(viewer.login, query, {
    read: sync?.enrichment.read,
    settled: stage.name === "ready",
  });

  const searching = terms.length > 0 || semantic.pending || semantic.results.length > 0;
  const { view, sort, controls } = useControls(searching);
  const order = sort === "best" ? undefined : orders[sort];
  const merged = useMemo(
    () => mergeResults({ matched, terms, hits: semantic.results, find: (id) => library.get(id), at, order }),
    [matched, terms, semantic.results, library, at, order],
  );

  const state = searchView({
    stage,
    search: { terms, ...merged, pending: semantic.pending, failed: semantic.failed },
    synced: sync?.syncedAt ? syncedAgo(sync.syncedAt, at) : undefined,
    timeLeft,
  });
  const surprised = useSurprise(semantic.results.length);
  const pose = surprised && state.pose === "idle" ? "surprised" : state.pose;
  useEffect(() => onPose(pose), [onPose, pose]);

  const retryLibrary = () => {
    setRetrying(true);
    reload().finally(() => setRetrying(false));
  };
  const search = (next: string) => {
    setQuery(next);
    navigate({ search: (previous) => ({ ...previous, q: next === "" ? undefined : next }), replace: true });
  };
  const open: OpenResult = (result, link) => {
    setOpener(link);
    navigate({ search: (previous) => ({ ...previous, repo: `${result.owner}/${result.name}` }) });
  };
  const entry =
    params.repo === undefined ? undefined : entries.find((repo) => `${repo.owner}/${repo.name}` === params.repo);
  const hit = semantic.results.find((result) => result.id === entry?.id);
  const opened = entry && (hit ? withReply(entry, hit) : entry);

  const body = (current: Body) => {
    switch (current.kind) {
      case "library":
        return (
          <LibraryView
            entries={entries}
            at={at}
            view={view}
            sort={sort}
            language={params.lang}
            arriving={stage.name === "importing" ? { total: stage.total } : undefined}
            pose={pose}
            onOpen={open}
          />
        );
      case "results":
        return <Results view={view} groups={current.groups} onOpen={open} />;
      case "empty-reading":
        return <EmptyTile pose={pose} ring={current.ring} {...current.copy} />;
      case "empty":
        return (
          <EmptyTile pose={pose} {...current.copy}>
            <RephraseChips phrases={current.phrases} onPick={search} />
          </EmptyTile>
        );
      case "failed":
        return <EmptyTile pose={pose} {...current.copy} />;
    }
  };

  return (
    <>
      <SearchTile
        query={query}
        onQueryChange={search}
        label="Search your stars"
        placeholder={stage.name === "importing" ? "search what has arrived" : idlePlaceholder}
        className={dock}
        progress={isReady ? state.progress : undefined}
        status={
          !isReady ? (
            loadingStatus
          ) : (
            <StatusLine
              icon={state.status.icon}
              label={state.status.label}
              detail={state.status.detail}
              continues={state.status.continues}
              action={
                state.status.retry && (
                  <Button
                    variant="bare"
                    size="default"
                    className="max-sm:h-[18px] max-sm:px-0 max-sm:text-sm max-sm:after:-inset-x-2 max-sm:after:-inset-y-2.5 max-sm:hover:bg-transparent"
                    onClick={retry}
                  >
                    try again
                  </Button>
                )
              }
            />
          )
        }
        controls={controls}
      />
      <div className="flex flex-col gap-gap max-sm:pb-44">
        {isLoadingError ? (
          <Notice
            heading="stargrep couldn't load your stars"
            detail="the library didn't arrive"
            pose="scared"
            action={
              <Button variant="primary" size="lg" disabled={retrying} onClick={retryLibrary}>
                Try again
              </Button>
            }
          />
        ) : !isReady ? (
          <Waiting view={view} searching={terms.length > 0} />
        ) : (
          body(state.body)
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
