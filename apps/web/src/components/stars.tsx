import {
  Button,
  EmptyTile,
  type OpenResult,
  type PipPose,
  RephraseChips,
  RepoPanel,
  Results,
  ScopeSwitch,
  SearchTile,
  type Sort,
  SortMenu,
  StatusLine,
  type View,
  ViewToggle,
} from "@stargrep/ui";
import { and, ilike } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useHydrated, useNavigate, useSearch } from "@tanstack/react-router";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keywordTerms, normalize } from "../lib/keyword.ts";
import { getLibrary, type Library, nothingSynced, useRecoveries } from "../lib/library-collection.ts";
import { type PageData, type PageRequest, pageOwner, type Session } from "../lib/page-data.ts";
import { pageView } from "../lib/page-view.ts";
import { now, startsIn, toDetail } from "../lib/present.ts";
import { withReply } from "../lib/results.ts";
import { useReveal } from "../lib/reveal.ts";
import type { Viewer } from "../lib/rpc.ts";
import { librarySorts, type Params, searchSorts } from "../lib/search-params.ts";
import { type Body, type Stage, stageOf } from "../lib/search-state.ts";
import { useStoredView } from "../lib/stored-view.ts";
import { libraryTrouble, type Trouble, troubleCopy } from "../lib/trouble.ts";
import { useSemanticSearch } from "../lib/use-semantic.ts";
import { useSync } from "../lib/use-sync.ts";
import { AccountMenu } from "./account-menu.tsx";
import { Hero, heroCopy, TryChips } from "./landing-hero.tsx";
import { type Arriving, LibraryPlaceholder, LibraryView } from "./library-view.tsx";
import { OwnerPill } from "./owner-pill.tsx";

// A navigation in the browser starts from the session the server loaded. The page reads the rest once it mounts.
export const pageFor = (request: PageRequest, { viewer, config }: Session): PageData => {
  const { owner, own, query } = pageOwner(viewer, config, request);
  return { viewer, owner, own, config, query, first: null, sync: null, refusal: null };
};

const scopes = [{ value: "stars", label: "Your stars", href: "/" }];

export function HeaderControls({ viewer }: { viewer: Viewer }) {
  return (
    <>
      <ScopeSwitch scopes={scopes} value="stars" className="max-sm:hidden" />
      <AccountMenu login={viewer.login} avatarUrl={viewer.avatarUrl} />
    </>
  );
}

const dock =
  "max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[max(16px,env(safe-area-inset-bottom))] max-sm:z-30 max-sm:[&_[data-slot=tile]]:shadow-dock";

// With an owner pill in the phone strip there is no room for the sort trigger, so phones sort by the default there.
function useControls(searching: boolean, roomForSort: boolean) {
  const params: Params = useSearch({ strict: false });
  const navigate = useNavigate();
  const [storedView, storeView] = useStoredView();
  const view = params.view ?? storedView;
  const sort = params.sort ?? (searching ? "best" : "starred");
  const setView = (next: View) => {
    storeView(next);
    navigate({ to: ".", search: (previous) => ({ ...previous, view: next }), replace: true });
  };
  const setSort = (next: Sort) =>
    navigate({ to: ".", search: (previous) => ({ ...previous, sort: next }), replace: true });
  const controls = (
    <>
      <div className={roomForSort ? "contents" : "contents max-sm:hidden"}>
        <SortMenu value={sort} onValueChange={setSort} options={searching ? searchSorts : librarySorts} />
      </div>
      <ViewToggle value={view} onValueChange={setView} />
    </>
  );
  return { view, sort, controls };
}

function Waiting({
  view,
  searching,
  arriving,
  visitor,
}: {
  view: View;
  searching: boolean;
  arriving: Arriving | undefined;
  visitor: boolean;
}) {
  return searching ? (
    <Results view={view} groups={[{ key: "all", results: [], pending: 4 }]} hero={visitor ? "card" : "butter"} />
  ) : (
    <LibraryPlaceholder view={view} arriving={arriving} butter={!visitor} />
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

const quiet = 600;

function useSurprise(query: string, landed: boolean) {
  const typedAt = useRef(0);
  const [surprised, setSurprised] = useState(false);
  useEffect(() => {
    typedAt.current = now();
  }, [query]);
  useEffect(() => {
    if (!landed) return;
    const wait = Math.max(0, quiet - (now() - typedAt.current));
    const fiber = Effect.runFork(
      Effect.sleep(Duration.millis(wait)).pipe(
        Effect.andThen(Effect.sync(() => setSurprised(true))),
        Effect.andThen(Effect.sleep(Duration.millis(1200))),
        Effect.ensuring(Effect.sync(() => setSurprised(false))),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [query, landed]);
  return surprised;
}

function useWhole(library: Library | undefined) {
  const [whole, setWhole] = useState(false);
  useEffect(() => {
    let current = true;
    library?.whole.then(() => {
      if (current) setWhole(true);
    });
    return () => {
      current = false;
    };
  }, [library]);
  return whole;
}

interface StarsProps {
  readonly data: PageData;
  readonly onPose: (pose: PipPose) => void;
}

// The server and the hydrating browser render without the library, so both paint the same first answer. The library
// loads once the page is hydrated.
export function Stars({ data, onPose }: StarsProps) {
  const hydrated = useHydrated();
  const empty = nothingSynced(data.first?.sync ?? data.sync);
  const library = hydrated ? getLibrary(data.owner, data.own, empty) : undefined;
  const recoveries = useRecoveries(library);
  return <OwnerStars key={recoveries} data={data} library={library} empty={empty} onPose={onPose} />;
}

// A login with nothing synced has an empty library, so the server already paints its state: ready to import, in line,
// or the first stars on their way.
function OwnerStars({ data, library, empty, onPose }: StarsProps & { library: Library | undefined; empty: boolean }) {
  const { owner, first } = data;
  const collection = library?.collection;
  const reloadRef = useRef(library?.reload);
  reloadRef.current = library?.reload;
  const reload = useCallback(() => {
    reloadRef.current?.();
  }, []);
  const [retrying, setRetrying] = useState(false);
  const [at] = useState(() => first?.at ?? now());
  const params: Params = useSearch({ strict: false });
  const navigate = useNavigate();
  const [query, setQuery] = useState(params.q ?? data.query);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const terms = useMemo(() => keywordTerms(query), [query]);

  const {
    data: entries = [],
    isReady: queried,
    isLoadingError,
  } = useLiveQuery((q) => (collection === undefined ? undefined : q.from({ repo: collection })));
  const { data: matched = [] } = useLiveQuery((q) => {
    const [head, ...rest] = terms;
    return head === undefined || collection === undefined
      ? undefined
      : q.from({ repo: collection }).where(({ repo }) => containsEvery(repo.text, [head, ...rest]));
  });
  const isReady = collection !== undefined && queried;
  // The server's first answer read every page, so it stays until the library has every page too. A view of the first
  // page alone can read differently, such as "found 20 so far" for a library still reading.
  const whole = useWhole(library);
  const { watch, retry } = useSync(owner, reload, first?.sync ?? data.sync ?? undefined, data.refusal ?? undefined);
  const sync = watch.kind === "watching" ? watch.status : undefined;
  const starred = data.own ? (data.viewer?.starredCount ?? null) : (sync?.starredTotal ?? null);
  const stage = stageOf({ sync, entries, starred });
  const estimate = useTimeLeft(stage);
  const timeLeft = stage.name === "importing" && stage.line !== null ? startsIn(stage.line.startsAt, now()) : estimate;
  const semantic = useSemanticSearch(owner, query, {
    read: sync?.enrichment.read,
    settled: stage.name === "ready",
    known: first === null ? undefined : { query: first.query, results: first.hits },
  });

  const searching = terms.length > 0 || semantic.pending || semantic.results.length > 0;
  const { view, sort, controls } = useControls(searching, data.own);
  const live = pageView({
    query,
    entries,
    matched,
    find: (id) => collection?.get(id),
    sync,
    starred,
    semantic,
    sort,
    at,
    timeLeft,
    whose: data.own ? undefined : owner,
  });
  const frozen =
    first !== null && !(isReady && whole) && normalize(query) === normalize(first.query) ? first.view : undefined;
  const state = frozen ?? live;
  const ready = isReady || frozen !== undefined || (empty && entries.length === 0);
  const trouble: Trouble | undefined =
    watch.kind !== "watching" ? watch.kind : isLoadingError ? libraryTrouble(library?.failure()) : undefined;
  const troubled = trouble === undefined ? undefined : troubleCopy(trouble, owner, data.own);
  const surprised = useSurprise(query, !semantic.pending && semantic.results.length > 0);
  const pose = troubled?.pose ?? (surprised && state.pose === "idle" ? "surprised" : state.pose);
  useEffect(() => onPose(pose), [onPose, pose]);

  const visitor = data.viewer === null;
  const reveal = useReveal(query, frozen !== undefined);
  const hero = heroCopy({ stage, troubled: trouble !== undefined, owner, demoLogin: data.config.demoLogin });
  const butterPose = reveal.phase === "typing" ? "thinking" : reveal.phase === "settled" ? "happy" : "idle";

  const retryLibrary = () => {
    setRetrying(true);
    library?.reload().finally(() => setRetrying(false));
  };
  const tryAgain = troubled?.retry === "sync" ? retry : troubled?.retry === "library" ? retryLibrary : undefined;
  const search = (next: string) => {
    setQuery(next);
    navigate({ to: ".", search: (previous) => ({ ...previous, q: next === "" ? undefined : next }), replace: true });
  };
  const open: OpenResult = (result, link) => {
    setOpener(link);
    navigate({ to: ".", search: (previous) => ({ ...previous, repo: `${result.owner}/${result.name}` }) });
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
            butter={!visitor}
            onOpen={open}
          />
        );
      case "results":
        return <Results view={view} groups={current.groups} hero={visitor ? "card" : "butter"} onOpen={open} />;
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
      {visitor && <Hero {...hero} pose={butterPose} />}
      <div data-reveal-tile className="contents">
        <SearchTile
          query={reveal.typed ?? query}
          onQueryChange={search}
          label={data.own ? "Search your stars" : `Search @${owner}'s stars`}
          placeholder={stage.name === "importing" ? "search what has arrived" : idlePlaceholder}
          className={dock}
          owner={data.own ? undefined : <OwnerPill owner={owner} viewer={data.viewer} config={data.config} />}
          progress={ready ? state.progress : undefined}
          status={
            troubled !== undefined ? (
              <StatusLine {...troubled.status} />
            ) : !ready ? (
              <StatusLine icon="busy" label={`loading ${data.own ? "your stars" : `@${owner}'s stars`}`} />
            ) : (
              <StatusLine
                icon={state.status.icon}
                label={state.status.label}
                phoneLabel={state.status.phoneLabel}
                detail={state.status.detail}
                phoneDetail={state.status.phoneDetail}
                continues={state.status.continues}
                instant={state.status.instant}
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
      </div>
      {visitor && (
        <TryChips
          examples={data.config.examples.filter((example) => normalize(example) !== normalize(query))}
          onPick={search}
        />
      )}
      <div data-reveal-results className="flex flex-col gap-gap max-sm:pb-44">
        {troubled !== undefined ? (
          <EmptyTile pose={troubled.pose} heading={troubled.heading} body={troubled.detail}>
            {tryAgain && (
              <Button variant="primary" size="lg" className="mt-2" disabled={retrying} onClick={tryAgain}>
                Try again
              </Button>
            )}
          </EmptyTile>
        ) : !ready ? (
          <Waiting
            view={view}
            searching={terms.length > 0}
            arriving={stage.name === "importing" ? { total: stage.total } : undefined}
            visitor={visitor}
          />
        ) : (
          body(state.body)
        )}
      </div>
      <RepoPanel
        repo={opened && toDetail(opened, at, data.own ? undefined : owner)}
        open={opened !== undefined}
        onOpenChange={(next) => {
          if (!next) navigate({ to: ".", search: (previous) => ({ ...previous, repo: undefined }) });
        }}
        returnFocus={opener}
      />
    </>
  );
}
