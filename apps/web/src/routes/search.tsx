import {
  Button,
  EmptyTile,
  type OpenResult,
  Pip,
  type PipPose,
  RephraseChips,
  RepoPanel,
  type ResultGroup,
  ResultPlaceholder,
  Results,
  ScopeSwitch,
  SearchTile,
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
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AccountMenu } from "../components/account-menu.tsx";
import { LibraryView } from "../components/library-view.tsx";
import { Page } from "../components/page.tsx";
import { SignInButton } from "../components/sign-in-button.tsx";
import { Wordmark } from "../components/wordmark.tsx";
import { keywordTerms } from "../lib/keyword.ts";
import { getLibrary, useRecoveries } from "../lib/library-collection.ts";
import { orders } from "../lib/order.ts";
import { enrichmentOf } from "../lib/planned.ts";
import { formatCount, now, syncedAgo, toDetail } from "../lib/present.ts";
import { mergeResults, withReply } from "../lib/results.ts";
import { api, signedOut, type Viewer } from "../lib/rpc.ts";
import {
  answerOf,
  headingsOf,
  rephrasings,
  type SearchView,
  type Stage,
  searchView,
  stageOf,
  unreadOf,
} from "../lib/search-state.ts";
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
const sortValues: ReadonlyArray<unknown> = ["best", "starred", "stars", "pushed"] satisfies ReadonlyArray<Sort>;

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
  const [pose, setPose] = useState<PipPose>("idle");
  return (
    <Page
      header={
        <>
          <Wordmark pose={state.status === "failed" ? "scared" : pose} />
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
  "max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[max(16px,env(safe-area-inset-bottom))] max-sm:z-30 max-sm:[&_[data-slot=tile]]:shadow-[0_10px_32px_#1e1b2e1f,0_1px_3px_#1e1b2e0f]";

function Placeholders({ count }: { count: number }) {
  return (
    <ol aria-busy className="view-tiles grid grid-cols-1 gap-gap sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }, (_, index) => `pending-${index}`).map((key) => (
        <li key={key}>
          <ResultPlaceholder />
        </li>
      ))}
    </ol>
  );
}

function Loading() {
  return (
    <>
      <SearchTile
        label="Search your stars"
        className={dock}
        status={<StatusLine icon="busy" label="loading your stars" />}
      />
      <div className="max-sm:pb-44">
        <Placeholders count={8} />
      </div>
    </>
  );
}

type Text = Parameters<typeof ilike>[0];

const containsEvery = (text: Text, [first, ...rest]: readonly [string, ...Array<string>]) => {
  const [second, ...others] = rest.map((term) => ilike(text, `%${term}%`));
  const head = ilike(text, `%${first}%`);
  return second === undefined ? head : and(head, second, ...others);
};

// Estimates the time left from the rate since the stage started. A new stage starts a new estimate.
function useTimeLeft(done: number, total: number | null, stage: Stage["name"]) {
  const [first, setFirst] = useState<{ readonly stage: string; readonly at: number; readonly done: number }>();
  const active = stage !== "ready";
  useEffect(() => {
    if (!active) setFirst(undefined);
    else setFirst((current) => (current?.stage === stage ? current : { stage, at: now(), done }));
  }, [active, stage, done]);
  if (!active || first === undefined || total === null) return "starting";
  const perSecond = (done - first.done) / Math.max(1, (now() - first.at) / 1000);
  if (perSecond <= 0) return "starting";
  const seconds = Math.ceil((total - done) / perSecond);
  if (seconds <= 5) return "almost done";
  return seconds < 90 ? `about ${seconds} seconds left` : `about ${Math.round(seconds / 60)} minutes left`;
}

// Pip looks surprised for a moment when results by meaning land, then settles.
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
  const [storedView, storeView] = useStoredView();
  const view = params.view ?? storedView;
  const [query, setQuery] = useState(params.q ?? "");
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [round, setRound] = useState(0);
  const terms = useMemo(() => keywordTerms(query), [query]);

  const { data: entries, isReady, isLoadingError } = useLiveQuery((q) => q.from({ repo: library }));
  const { data: matched = [] } = useLiveQuery((q) => {
    const [first, ...rest] = terms;
    return first === undefined
      ? undefined
      : q.from({ repo: library }).where(({ repo }) => containsEvery(repo.text, [first, ...rest]));
  });
  const semantic = useSemanticSearch(viewer.login, query, round);
  const { status: sync, retry } = useSync(viewer.login, reload);

  const enrichment = enrichmentOf(sync);
  const stage = stageOf({
    importing: sync?.state === "queued",
    imported: entries.length,
    starred: viewer.starredCount,
    enrichment,
  });
  const timeLeft = useTimeLeft(
    stage.name === "importing" ? stage.done : stage.name === "reading" ? stage.settled : 0,
    stage.name === "ready" ? null : stage.total,
    stage.name,
  );

  const partial = useRef(stage.name !== "ready");
  useEffect(() => {
    if (partial.current && stage.name === "ready") setRound((value) => value + 1);
    partial.current = stage.name !== "ready";
  }, [stage.name]);

  const searching = terms.length > 0 || semantic.pending || semantic.results.length > 0;
  const sort = params.sort ?? (searching ? "best" : "starred");
  const order = sort === "best" ? undefined : orders[sort];
  const merged = useMemo(
    () => mergeResults({ matched, terms, hits: semantic.results, find: (id) => library.get(id), at, order }),
    [matched, terms, semantic.results, library, at, order],
  );
  const found = merged.words.length + merged.meaning.length;

  const state: SearchView = searchView({
    stage,
    answer: answerOf({ searching, found, pending: semantic.pending, failed: semantic.failed }),
    synced: sync?.syncedAt ? syncedAgo(sync.syncedAt, at) : undefined,
    syncFailed: sync?.state === "failed",
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
  const setView = (next: View) => {
    storeView(next);
    navigate({ search: (previous) => ({ ...previous, view: next }), replace: true });
  };
  const setSort = (next: Sort) => navigate({ search: (previous) => ({ ...previous, sort: next }), replace: true });
  const open: OpenResult = (result, link) => {
    setOpener(link);
    navigate({ search: (previous) => ({ ...previous, repo: `${result.owner}/${result.name}` }) });
  };
  const entry =
    params.repo === undefined ? undefined : entries.find((repo) => `${repo.owner}/${repo.name}` === params.repo);
  const hit = semantic.results.find((result) => result.id === entry?.id);
  const opened = entry && (hit ? withReply(entry, hit) : entry);

  const headings = headingsOf(stage, merged.words.length, merged.meaning.length);
  const pending = semantic.pending ? (found === 0 ? 4 : 2) : 0;
  const groups: ReadonlyArray<ResultGroup> =
    headings === undefined
      ? [{ key: "all", results: [...merged.words, ...merged.meaning], pending }]
      : [
          ...(merged.words.length > 0 ? [{ key: "words", heading: headings.words, results: merged.words }] : []),
          ...(merged.meaning.length > 0 || pending > 0
            ? [{ key: "meaning", heading: headings.meaning, results: merged.meaning, pending }]
            : []),
        ];
  const unread = unreadOf(stage);

  return (
    <>
      <SearchTile
        query={query}
        onQueryChange={search}
        label="Search your stars"
        placeholder={
          stage.name === "importing" ? "search what has arrived" : "the rust tui library I starred last year"
        }
        className={dock}
        progress={state.rail}
        status={
          <StatusLine
            icon={state.status.icon}
            label={state.status.label}
            detail={state.status.detail}
            action={
              state.status.retry && (
                <Button variant="bare" size="default" onClick={retry}>
                  try again
                </Button>
              )
            }
          />
        }
        controls={
          <>
            <SortMenu
              value={sort}
              onValueChange={setSort}
              options={searching ? ["best", "starred", "stars", "pushed"] : ["starred", "stars", "pushed"]}
            />
            <ViewToggle value={view} onValueChange={setView} />
          </>
        }
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
          <Placeholders count={8} />
        ) : state.body === "library" ? (
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
        ) : state.body === "results" ? (
          <Results view={view} groups={groups} onOpen={open} />
        ) : state.body === "empty-reading" ? (
          <EmptyTile
            pose={pose}
            ring={state.rail}
            heading={unread ? `not in the ${formatCount(unread.read)} i've read yet` : "not in what has arrived yet"}
            body={
              unread
                ? `it might be in the ${formatCount(unread.unread)} stars i'm still reading.`
                : "more stars are still arriving."
            }
            meta={`i'll search again when reading finishes · ${timeLeft}`}
          />
        ) : state.body === "empty" ? (
          <EmptyTile
            pose={pose}
            heading={`nothing in all ${formatCount(entries.length)} stars`}
            body="i've read all of them, and none matches that. maybe you starred it under different words. try one of these:"
          >
            <RephraseChips phrases={rephrasings(terms)} onPick={search} />
          </EmptyTile>
        ) : (
          <EmptyTile
            pose={pose}
            heading="stargrep couldn't search that"
            body="the search didn't answer. try again in a moment."
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
